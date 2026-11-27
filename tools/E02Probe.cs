using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public sealed class E02TextureSettings : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith("Assets/Fixtures/e02/", StringComparison.Ordinal)) return;
        var importer = (TextureImporter)assetImporter;
        importer.isReadable = true;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.mipmapEnabled = false;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.maxTextureSize = 4096;
        importer.alphaIsTransparency = false;
        importer.sRGBTexture = true;
    }
}

public static class E02Probe
{
    [Serializable] sealed class Report
    {
        public string unityVersion;
        public int rawWidth, rawHeight, atlasWidth, atlasHeight, triangles;
        public Color32 brush, stamp, alpha;
        public bool rawBaseColorMatches, atlasBaseColorMatches;
    }

    static (Mesh mesh, Texture2D texture) Read(string label)
    {
        var path = Directory.GetFiles($"Assets/Fixtures/e02/{label}", "*.fbx").Single().Replace('\\', '/');
        var model = AssetDatabase.LoadAssetAtPath<GameObject>(path);
        var filter = model.GetComponentsInChildren<MeshFilter>().Single();
        var texture = filter.GetComponent<MeshRenderer>().sharedMaterial.GetTexture("_MainTex") as Texture2D;
        if (texture == null) throw new InvalidOperationException("Unity did not resolve the Base Color map.");
        return (filter.sharedMesh, texture);
    }

    static Color32 Texel(Texture2D texture, int x, int y) => texture.GetPixels32()[(texture.height - y - 1) * texture.width + x];

    static bool Exact(Texture2D texture, string expected) =>
        File.ReadAllBytes(AssetDatabase.GetAssetPath(texture)).SequenceEqual(File.ReadAllBytes(expected));

    public static void Run()
    {
        E01Probe.Run();
        var (original, _) = Read("source");
        var (raw, rawTexture) = Read("raw");
        var (atlas, atlasTexture) = Read("atlas");
        if (!original.vertices.SequenceEqual(raw.vertices) || !original.triangles.SequenceEqual(raw.triangles) ||
            !original.normals.SequenceEqual(raw.normals) || !original.uv.SequenceEqual(raw.uv) ||
            atlas.triangles.Length != original.triangles.Length || atlas.uv.Length != 8 || atlas.uv2.Length != 8) {
            throw new InvalidOperationException("The texture export changed the raw mesh or lost an atlas UV channel.");
        }
        var report = new Report {
            unityVersion = Application.unityVersion, rawWidth = rawTexture.width, rawHeight = rawTexture.height,
            atlasWidth = atlasTexture.width, atlasHeight = atlasTexture.height, triangles = raw.triangles.Length / 3,
            brush = Texel(rawTexture, 12, 25), stamp = Texel(rawTexture, 14, 31), alpha = Texel(rawTexture, 7, 4),
            rawBaseColorMatches = Exact(rawTexture, "alpha.png"), atlasBaseColorMatches = Exact(atlasTexture, "atlas-2d-and-3d.png"),
        };
        File.WriteAllText("e02-report.json", JsonUtility.ToJson(report, true));
        if (!report.rawBaseColorMatches || !report.atlasBaseColorMatches ||
            !report.brush.Equals(new Color32(255, 34, 0, 255)) || !report.stamp.Equals(new Color32(48, 124, 152, 255)) ||
            !report.alpha.Equals(new Color32(53, 0, 240, 128))) {
            throw new InvalidOperationException("Unity did not retain the edited texels. See e02-report.json.");
        }
    }
}
