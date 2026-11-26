using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public sealed class E00DirectionalNormalImportSettings : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith("Assets/Fixtures/directional/", StringComparison.Ordinal) ||
            !Path.GetFileName(assetPath).Equals("Normal.png", StringComparison.OrdinalIgnoreCase)) return;
        var importer = (TextureImporter)assetImporter;
        importer.textureType = TextureImporterType.NormalMap;
        importer.flipGreenChannel = false;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.maxTextureSize = 4096;
        importer.mipmapEnabled = true;
        importer.filterMode = FilterMode.Trilinear;
        importer.wrapMode = TextureWrapMode.Clamp;
    }
}

public static class NormalBakeProbe
{
    const int Size = 640;
    const int EdgeGuard = 6;
    const float MaxAngle = 2;
    const float LightPreferenceMargin = 0.05f;
    static readonly Vector3 LightA = new Vector3(0, 0.8f, 0.6f);
    static readonly Vector3 LightB = new Vector3(0, -0.8f, 0.6f);

    [Serializable] sealed class Report
    {
        public string unityVersion, graphicsDevice;
        public int framebufferWidth, edgeGuardPixels, atlasWidth, atlasHeight;
        public Panel[] panels;
    }

    [Serializable] sealed class Panel
    {
        public string name;
        public float sourceTangentSign, exportedTangentSign, tangentRotationDegrees, maxAngularErrorDegrees, meanAngularErrorDegrees;
        public float maxCopiedRgbErrorDegrees, meanCopiedRgbErrorDegrees, maxLightDifference, maxSourceNormalTiltDegrees;
        public int samples, preferredLightA, preferredLightB, invertedLightSamples, copiedRgbFailures, copiedRgbInvertedLightSamples;
        public double angleSum, copiedAngleSum;
    }

    sealed class Fixture : IDisposable
    {
        public readonly GameObject root;
        public readonly Material material;
        public readonly Renderer renderer;
        public readonly Mesh mesh;
        public readonly Texture2D normal;

        public Fixture(string directory, Shader shader)
        {
            var path = Directory.GetFiles(directory, "*.fbx").Single().Replace('\\', '/');
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) throw new InvalidOperationException($"Unity did not import {path}.");
            root = UnityEngine.Object.Instantiate(prefab);
            var filter = root.GetComponentInChildren<MeshFilter>();
            renderer = filter.GetComponent<Renderer>();
            mesh = filter.sharedMesh;
            normal = renderer.sharedMaterial.GetTexture("_BumpMap") as Texture2D;
            if (normal == null || mesh.tangents.Length != mesh.vertexCount)
                throw new InvalidOperationException("The FBX must import a linked Normal Map and MikkTSpace tangents.");
            material = new Material(shader);
            material.SetTexture("_BumpMap", normal);
            material.SetVector("_LightA", LightA);
            material.SetVector("_LightB", LightB);
            renderer.sharedMaterial = material;
            root.SetActive(false);
        }

        public (Vector3 direction, float sign, Vector3 normal) Frame(int panel)
        {
            var normals = mesh.normals;
            var tangents = mesh.tangents;
            int index = Array.FindIndex(normals, n => (Mathf.Abs(n.z) > 0.8f ? 0 : 1) == panel);
            if (index < 0) throw new InvalidOperationException("The folded fixture lost a panel.");
            var tangent = tangents[index];
            var matrix = renderer.localToWorldMatrix;
            var direction = matrix.MultiplyVector(new Vector3(tangent.x, tangent.y, tangent.z)).normalized;
            return (direction, tangent.w * Mathf.Sign(matrix.determinant), matrix.inverse.transpose.MultiplyVector(normals[index]).normalized);
        }

        public void Dispose()
        {
            UnityEngine.Object.DestroyImmediate(root);
            UnityEngine.Object.DestroyImmediate(material);
        }
    }

    public static void Run()
    {
        var shader = Shader.Find("Hidden/AssetFixer/NormalBakeProbe");
        if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null || shader == null || !shader.isSupported ||
            !SystemInfo.SupportsRenderTextureFormat(RenderTextureFormat.ARGBFloat))
            throw new InvalidOperationException("The normal probe needs a floating-point render target and its Unity shader.");
        Directory.CreateDirectory("captures");
        var cameraObject = new GameObject("Normal verification", typeof(Camera));
        var camera = cameraObject.GetComponent<Camera>();
        camera.orthographic = true;
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = Color.clear;
        camera.allowHDR = false;
        camera.allowMSAA = false;
        var target = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGBFloat, RenderTextureReadWrite.Linear);
        var frame = new Texture2D(Size, Size, TextureFormat.RGBAFloat, false, true);
        camera.targetTexture = target;
        try {
            using (var source = new Fixture("Assets/Fixtures/directional/original", shader))
            using (var baked = new Fixture("Assets/Fixtures/directional/exported", shader)) {
                var panels = Compare(source, baked, camera, frame);
                var report = new Report { unityVersion = Application.unityVersion, graphicsDevice = SystemInfo.graphicsDeviceName,
                    framebufferWidth = Size, edgeGuardPixels = EdgeGuard, atlasWidth = baked.normal.width, atlasHeight = baked.normal.height, panels = panels };
                File.WriteAllText("normal-report.json", JsonUtility.ToJson(report, true));
                if (panels[0].sourceTangentSign != panels[0].exportedTangentSign ||
                    panels[1].sourceTangentSign == panels[1].exportedTangentSign ||
                    Mathf.Abs(panels[0].tangentRotationDegrees - 37) > 0.1f ||
                    Mathf.Abs(panels[1].tangentRotationDegrees - 23) > 0.1f ||
                    panels.Sum(panel => panel.copiedRgbInvertedLightSamples) < 1000 ||
                    panels.Any(panel => panel.samples < 5000 ||
                    panel.maxAngularErrorDegrees > MaxAngle || panel.maxSourceNormalTiltDegrees < 25 ||
                    panel.preferredLightA < 1000 || panel.preferredLightB < 1000 || panel.invertedLightSamples != 0 ||
                    panel.copiedRgbFailures < 1000))
                    throw new InvalidOperationException("The directional normal gate failed. See normal-report.json.");
            }
        } finally {
            camera.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(frame);
            UnityEngine.Object.DestroyImmediate(target);
            UnityEngine.Object.DestroyImmediate(cameraObject);
        }
    }

    static Panel[] Compare(Fixture source, Fixture baked, Camera camera, Texture2D frame)
    {
        if (baked.mesh.uv2.Length != baked.mesh.vertexCount)
            throw new InvalidOperationException("The copied-RGB control requires the saved original UVs.");
        var bounds = source.renderer.bounds;
        camera.orthographicSize = bounds.size.magnitude * 0.49f;
        camera.transform.position = bounds.center + new Vector3(0.13f, 0.16f, 1) * 4;
        camera.transform.LookAt(bounds.center);
        var before = Capture(source, camera, frame, source.normal, false, false);
        var after = Capture(baked, camera, frame, baked.normal, false, false);
        var copied = Capture(baked, camera, frame, source.normal, true, false);
        var beforeLit = Capture(source, camera, frame, source.normal, false, true);
        var afterLit = Capture(baked, camera, frame, baked.normal, false, true);
        var copiedLit = Capture(baked, camera, frame, source.normal, true, true);

        var panels = new[] { new Panel { name = "Rotated UV" }, new Panel { name = "Mirrored and rotated UV" } };
        var baseNormals = new Vector3[2];
        for (int i = 0; i < panels.Length; i++) {
            var original = source.Frame(i);
            var exported = baked.Frame(i);
            panels[i].sourceTangentSign = original.sign;
            panels[i].exportedTangentSign = exported.sign;
            panels[i].tangentRotationDegrees = Angle(original.direction, exported.direction);
            baseNormals[i] = original.normal;
        }
        for (int y = EdgeGuard; y < Size - EdgeGuard; y++) for (int x = EdgeGuard; x < Size - EdgeGuard; x++) {
            int i = y * Size + x;
            if (before[i].a < 0.25f || !IsSourceInterior(before, i)) continue;
            if (before[i].a != after[i].a || before[i].a != copied[i].a)
                throw new InvalidOperationException("The baked mesh lost a reference interior point.");
            int panel = before[i].a > 0.75f ? 1 : 0;
            var data = panels[panel];
            var n = Normal(before[i]);
            var angle = Angle(n, Normal(after[i]));
            var copiedAngle = Angle(n, Normal(copied[i]));
            data.samples++;
            data.angleSum += angle;
            data.copiedAngleSum += copiedAngle;
            data.maxAngularErrorDegrees = Mathf.Max(data.maxAngularErrorDegrees, angle);
            data.maxCopiedRgbErrorDegrees = Mathf.Max(data.maxCopiedRgbErrorDegrees, copiedAngle);
            data.maxSourceNormalTiltDegrees = Mathf.Max(data.maxSourceNormalTiltDegrees, Angle(n, baseNormals[panel]));
            if (copiedAngle > MaxAngle) data.copiedRgbFailures++;
            var a = beforeLit[i];
            var b = afterLit[i];
            var c = copiedLit[i];
            data.maxLightDifference = Mathf.Max(data.maxLightDifference, Mathf.Max(Mathf.Abs(a.r - b.r), Mathf.Abs(a.g - b.g)));
            var preference = a.r - a.g;
            if (Mathf.Abs(preference) <= LightPreferenceMargin) continue;
            if (preference > 0) data.preferredLightA++;
            else data.preferredLightB++;
            if (preference * (b.r - b.g) <= 0) data.invertedLightSamples++;
            if (preference * (c.r - c.g) <= 0) data.copiedRgbInvertedLightSamples++;
        }
        foreach (var panel in panels) {
            panel.meanAngularErrorDegrees = (float)(panel.angleSum / Math.Max(1, panel.samples));
            panel.meanCopiedRgbErrorDegrees = (float)(panel.copiedAngleSum / Math.Max(1, panel.samples));
        }
        WriteLightCapture(beforeLit, "original");
        WriteLightCapture(afterLit, "baked");
        WriteLightCapture(copiedLit, "copied-rgb-control");
        return panels;
    }

    static bool IsSourceInterior(Color[] view, int center)
    {
        var sample = view[center];
        // Use only the source image to exclude silhouettes, seams and texture transitions.
        for (int dy = -EdgeGuard; dy <= EdgeGuard; dy++) for (int dx = -EdgeGuard; dx <= EdgeGuard; dx++) {
            var neighbor = view[center + dy * Size + dx];
            if (sample.a != neighbor.a || Mathf.Abs(sample.r - neighbor.r) > 0.0002f ||
                Mathf.Abs(sample.g - neighbor.g) > 0.0002f || Mathf.Abs(sample.b - neighbor.b) > 0.0002f) return false;
        }
        return true;
    }

    static Vector3 Normal(Color color)
    {
        var direction = new Vector3(2 * color.r - 1, 2 * color.g - 1, 2 * color.b - 1);
        if (!(direction.sqrMagnitude > 0.99f && direction.sqrMagnitude < 1.01f))
            throw new InvalidOperationException("The render must contain a finite unit normal.");
        return direction.normalized;
    }
    static float Angle(Vector3 a, Vector3 b) => Mathf.Atan2(Vector3.Cross(a, b).magnitude, Vector3.Dot(a, b)) * Mathf.Rad2Deg;

    static Color[] Capture(Fixture fixture, Camera camera, Texture2D frame, Texture2D normal, bool oldUv, bool lighting)
    {
        fixture.material.SetTexture("_BumpMap", normal);
        fixture.material.SetFloat("_OldUv", oldUv ? 1 : 0);
        fixture.material.SetFloat("_Lighting", lighting ? 1 : 0);
        fixture.root.SetActive(true);
        camera.Render();
        var previous = RenderTexture.active;
        RenderTexture.active = camera.targetTexture;
        frame.ReadPixels(new Rect(0, 0, Size, Size), 0, 0, false);
        RenderTexture.active = previous;
        fixture.root.SetActive(false);
        return frame.GetPixels();
    }

    static void WriteLightCapture(Color[] capture, string name)
    {
        var frame = new Texture2D(Size, Size, TextureFormat.RGB24, false, true);
        for (int light = 0; light < 2; light++) {
            frame.SetPixels(capture.Select(pixel => {
                if (pixel.a < 0.25f) return new Color(0.07f, 0.09f, 0.13f);
                var value = 0.12f + 0.88f * (light == 0 ? pixel.r : pixel.g);
                return new Color(value, value, value);
            }).ToArray());
            frame.Apply();
            File.WriteAllBytes($"captures/{name}-light-{light + 1}.png", frame.EncodeToPNG());
        }
        UnityEngine.Object.DestroyImmediate(frame);
    }
}
