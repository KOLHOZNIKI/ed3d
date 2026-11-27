using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;

public static class E01Probe
{
    [Serializable] sealed class Result
    {
        public string unityVersion;
        public int triangles, vertices, primaryUv, originalUv, width, height;
        public string baseColorSha256;
    }

    static (Mesh mesh, Texture2D texture) Read(string side)
    {
        var fbx = Directory.GetFiles($"Assets/Fixtures/static-restored/{side}", "*.fbx").Single().Replace('\\', '/');
        var model = AssetDatabase.LoadAssetAtPath<GameObject>(fbx);
        var filter = model.GetComponentsInChildren<MeshFilter>().Single();
        var material = filter.GetComponent<MeshRenderer>().sharedMaterials.Single();
        var texture = material.GetTexture("_MainTex") as Texture2D;
        if (texture == null) throw new InvalidOperationException("Unity did not resolve the restored Base Color map.");
        return (filter.sharedMesh, texture);
    }

    static string TextureHash(Texture2D texture)
    {
        using (var sha256 = SHA256.Create()) {
            var bytes = File.ReadAllBytes(AssetDatabase.GetAssetPath(texture));
            return string.Concat(sha256.ComputeHash(bytes).Select(value => value.ToString("x2")));
        }
    }

    public static void Run()
    {
        var (before, beforeTexture) = Read("original");
        var (after, afterTexture) = Read("exported");
        var restoredHash = TextureHash(afterTexture);
        if (before.triangles.Length != 12 || !before.triangles.SequenceEqual(after.triangles) ||
            !before.vertices.SequenceEqual(after.vertices) || !before.normals.SequenceEqual(after.normals) ||
            !before.uv.SequenceEqual(after.uv) || !before.uv2.SequenceEqual(after.uv2) || after.uv2.Length != after.vertexCount ||
            restoredHash != TextureHash(beforeTexture) || beforeTexture.width != afterTexture.width || beforeTexture.height != afterTexture.height) {
            throw new InvalidOperationException("The project round-trip changed the imported static asset.");
        }
        SharedSkinProbe.Run();
        File.WriteAllText("e01-static-report.json", JsonUtility.ToJson(new Result {
            unityVersion = Application.unityVersion, triangles = after.triangles.Length / 3, vertices = after.vertexCount,
            primaryUv = after.uv.Length, originalUv = after.uv2.Length, width = afterTexture.width, height = afterTexture.height,
            baseColorSha256 = restoredHash,
        }, true));
    }
}
