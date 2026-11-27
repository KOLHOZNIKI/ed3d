using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public sealed class E00BakeTextureSettings : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith("Assets/Fixtures/", StringComparison.Ordinal)) return;
        var importer = (TextureImporter)assetImporter;
        var name = Path.GetFileNameWithoutExtension(assetPath).ToLowerInvariant();
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.maxTextureSize = 4096;
        importer.mipmapEnabled = true;
        importer.filterMode = FilterMode.Trilinear;
        if (name == "normal" || name.EndsWith("_normal_bake")) importer.textureType = TextureImporterType.NormalMap;
        if (name.EndsWith("roughness") || name.EndsWith("metallic")) importer.sRGBTexture = false;
    }
}

public static class TextureBakeProbe
{
    [Serializable] sealed class Report
    {
        public string unityVersion, graphicsDevice;
        public Result[] results;
    }

    [Serializable] sealed class Result
    {
        public string fixture, reference, pass;
        public int views, seamEdges, silhouetteDifferences;
        public int paintCorePixels, paintGaps, newBlackPixels;
        public Error all = new Error(), seam = new Error(), interior = new Error();
    }

    [Serializable] sealed class Error
    {
        public int pixels;
        public float mae, p95, p99, max;
        readonly int[] histogram = new int[256];
        double total;

        public void Add(float value)
        {
            total += value;
            pixels++;
            max = Mathf.Max(max, value);
            histogram[Mathf.Clamp(Mathf.CeilToInt(value * 255f), 0, 255)]++;
        }

        public void Finish()
        {
            if (pixels == 0) throw new InvalidOperationException("The comparison did not capture a visible region.");
            mae = (float)(total / pixels);
            p95 = Percentile(0.95);
            p99 = Percentile(0.99);
        }

        float Percentile(double fraction)
        {
            int count = 0;
            for (int i = 0; i < histogram.Length; i++) {
                count += histogram[i];
                if (count >= pixels * fraction) return i / 255f;
            }
            return 1;
        }
    }

    sealed class CaptureModel : IDisposable
    {
        public readonly GameObject model;
        public readonly Material display;
        public readonly Mesh mesh;
        public readonly int seamEdges;
        public readonly Texture sourceColor;
        public readonly Dictionary<string, Texture> scalarMaps = new Dictionary<string, Texture>();

        public CaptureModel(string folder, Shader shader, bool measureSeams)
        {
            var path = Directory.GetFiles(folder, "*.fbx").Single().Replace('\\', '/');
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) throw new InvalidOperationException($"Unity did not import {path}");
            var root = UnityEngine.Object.Instantiate(prefab);
            var skin = root.GetComponentInChildren<SkinnedMeshRenderer>();
            var filter = root.GetComponentInChildren<MeshFilter>();
            Renderer renderer = skin != null ? (Renderer)skin : filter.GetComponent<Renderer>();
            var imported = skin != null ? skin.sharedMesh : filter.sharedMesh;
            var original = renderer.sharedMaterial;
            sourceColor = original.GetTexture("_MainTex");
            var normal = original.GetTexture("_BumpMap");
            if (sourceColor == null || (skin != null && normal == null)) {
                throw new InvalidOperationException($"A linked texture did not import in {path}");
            }
            foreach (var channel in new[] { "roughness", "metallic" }) {
                var files = Directory.GetFiles(folder, "*.*", SearchOption.AllDirectories)
                    .Where(file => Path.GetFileNameWithoutExtension(file).EndsWith(channel, StringComparison.OrdinalIgnoreCase));
                var file = files.SingleOrDefault();
                if (file != null) scalarMaps.Add(channel, AssetDatabase.LoadAssetAtPath<Texture>(file.Replace('\\', '/')));
            }

            var deformation = new Mesh();
            if (skin != null) skin.BakeMesh(deformation, false);
            var shape = skin != null ? deformation : imported;
            var world = renderer.localToWorldMatrix;
            var normalMatrix = world.inverse.transpose;
            var sign = world.determinant < 0 ? -1f : 1f;
            var positions = shape.vertices.Select(world.MultiplyPoint3x4).ToArray();
            var normals = shape.normals.Select(n => normalMatrix.MultiplyVector(n).normalized).ToArray();
            var tangents = shape.tangents.Select(v => {
                var t = world.MultiplyVector(new Vector3(v.x, v.y, v.z)).normalized;
                return new Vector4(t.x, t.y, t.z, v.w * sign);
            }).ToArray();
            var indices = imported.triangles;
            if (sign < 0) {
                for (int i = 0; i < indices.Length; i += 3) (indices[i + 1], indices[i + 2]) = (indices[i + 2], indices[i + 1]);
            }
            var uv = imported.uv;
            var seams = new Vector3[indices.Length / 3];
            if (measureSeams) seamEdges = MarkSeams(positions, uv, imported.uv2, indices, seams);
            mesh = new Mesh { indexFormat = IndexFormat.UInt32 };
            mesh.vertices = indices.Select(i => positions[i]).ToArray();
            mesh.normals = indices.Select(i => normals[i]).ToArray();
            mesh.tangents = indices.Select(i => tangents[i]).ToArray();
            mesh.uv = indices.Select(i => uv[i]).ToArray();
            var barycentric = new[] { Color.red, Color.green, Color.blue };
            mesh.colors = Enumerable.Range(0, indices.Length).Select(i => barycentric[i % 3]).ToArray();
            mesh.SetUVs(2, Enumerable.Range(0, indices.Length).Select(i => seams[i / 3]).ToList());
            mesh.triangles = Enumerable.Range(0, indices.Length).ToArray();
            model = new GameObject("Texture comparison", typeof(MeshFilter), typeof(MeshRenderer));
            model.GetComponent<MeshFilter>().sharedMesh = mesh;
            display = new Material(shader);
            display.SetTexture("_MainTex", sourceColor);
            if (normal != null) display.SetTexture("_BumpMap", normal);
            display.SetFloat("_Normal", normal != null ? 1 : 0);
            model.GetComponent<MeshRenderer>().sharedMaterial = display;
            model.SetActive(false);
            UnityEngine.Object.DestroyImmediate(root);
            UnityEngine.Object.DestroyImmediate(deformation);
        }

        public void SetPass(string pass)
        {
            var texture = sourceColor;
            if ((pass == "roughness" || pass == "metallic") && (!scalarMaps.TryGetValue(pass, out texture) || texture == null)) {
                throw new InvalidOperationException($"The {pass} probe requires an imported data map.");
            }
            display.SetTexture("_MainTex", texture);
            display.SetFloat("_Mode", pass == "Normal" ? 2 : pass == "Lit" ? 0 : 1);
        }

        public void Dispose()
        {
            UnityEngine.Object.DestroyImmediate(model);
            UnityEngine.Object.DestroyImmediate(display);
            UnityEngine.Object.DestroyImmediate(mesh);
        }
    }

    static int MarkSeams(Vector3[] positions, Vector2[] uv, Vector2[] oldUv, int[] indices, Vector3[] flags)
    {
        if (oldUv.Length != uv.Length) throw new InvalidOperationException("The baked FBX must retain the original UVs.");
        var edges = new Dictionary<(Vector3Int, Vector3Int), List<(int corner, Vector2 a, Vector2 b, Vector2 oldA, Vector2 oldB)>>();
        Vector3Int Key(Vector3 v) => Vector3Int.RoundToInt(v * 1000000);
        for (int i = 0; i < indices.Length; i++) {
            var start = i / 3 * 3;
            var a = indices[start + (i + 1 - start) % 3];
            var b = indices[start + (i + 2 - start) % 3];
            var p = Key(positions[a]);
            var q = Key(positions[b]);
            if (p == q) continue;
            if (p.x > q.x || (p.x == q.x && (p.y > q.y || (p.y == q.y && p.z > q.z)))) {
                (p, q) = (q, p);
                (a, b) = (b, a);
            }
            if (!edges.TryGetValue((p, q), out var sides)) edges[(p, q)] = sides = new List<(int, Vector2, Vector2, Vector2, Vector2)>();
            sides.Add((i, uv[a], uv[b], oldUv[a], oldUv[b]));
        }
        int seams = 0;
        foreach (var sides in edges.Values) {
            if (sides.Count != 2) continue;
            var a = sides[0];
            var b = sides[1];
            if ((a.oldA - b.oldA).sqrMagnitude > 1e-12f || (a.oldB - b.oldB).sqrMagnitude > 1e-12f) continue;
            if ((a.a - b.a).sqrMagnitude <= 1e-12f && (a.b - b.b).sqrMagnitude <= 1e-12f) continue;
            flags[a.corner / 3][a.corner % 3] = 1;
            flags[b.corner / 3][b.corner % 3] = 1;
            seams++;
        }
        return seams;
    }

    public static void Run() => Run(false);

    public static void RunPreservingPaint() => Run(true);

    static void Run(bool paintedSource)
    {
        var shader = Shader.Find("Hidden/AssetFixer/TextureBakeProbe");
        if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null || shader == null || !shader.isSupported) {
            throw new InvalidOperationException("The Unity texture probe requires a graphics device and its diagnostic shader.");
        }
        Directory.CreateDirectory("captures");
        var results = new List<Result>();
        var cameraObject = new GameObject("Texture Bake Camera", typeof(Camera));
        var camera = cameraObject.GetComponent<Camera>();
        camera.orthographic = true;
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(0.07f, 0.08f, 0.10f, 0);
        camera.allowHDR = false;
        camera.allowMSAA = false;
        camera.nearClipPlane = 0.01f;
        camera.farClipPlane = 30;
        var target = new RenderTexture(768, 768, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear);
        var pixels = new Texture2D(target.width, target.height, TextureFormat.RGBA32, false, true);
        camera.targetTexture = target;
        try {
            foreach (var fixture in Directory.GetDirectories("Assets/Fixtures")) {
                if (!Directory.Exists(Path.Combine(fixture, "reference"))) continue;
                var name = Path.GetFileName(fixture);
                using (var original = new CaptureModel(Path.Combine(fixture, "original"), shader, false))
                using (var reference = new CaptureModel(Path.Combine(fixture, "reference"), shader, false))
                using (var baked = new CaptureModel(Path.Combine(fixture, "exported"), shader, true)) {
                    var modes = name == "skinned" ? new[] { "Lit", "BaseColor", "Normal", "roughness", "metallic" }
                        : new[] { "Lit", "BaseColor" };
                    foreach (var pass in modes) {
                        var raw = NewResult(name, "original", pass, baked);
                        var triangulated = NewResult(name, "same triangles", pass, baked);
                        original.SetPass(pass);
                        reference.SetPass(pass);
                        baked.SetPass(pass);
                        var bounds = original.mesh.bounds;
                        foreach (var direction in new[] {
                            new Vector3(0.8f, 0.65f, -1), new Vector3(-0.6f, 0.35f, 1),
                            new Vector3(0.05f, 1, 0.11f), new Vector3(0.25f, -0.65f, -1),
                            new Vector3(1, 0.2f, 0.1f), new Vector3(0.1f, 0.3f, -1)
                        }) {
                            camera.transform.position = bounds.center + direction.normalized * (3 * bounds.size.magnitude);
                            camera.transform.LookAt(bounds.center);
                            camera.orthographicSize = bounds.size.magnitude * (raw.views < 5 ? 0.40f : 0.63f);
                            var beforePixels = Capture(original, camera, pixels);
                            var refPixels = Capture(reference, camera, pixels);
                            var afterPixels = Capture(baked, camera, pixels);
                            Compare(raw, beforePixels, afterPixels);
                            Compare(triangulated, refPixels, afterPixels);
                            if (paintedSource && name == "static" && pass == "Lit")
                                CountPaintCore(raw, beforePixels, afterPixels, target.width);
                            if (pass == "Lit") {
                                Write(pixels, beforePixels, $"captures/{name}-{raw.views}-original.png");
                                Write(pixels, afterPixels, $"captures/{name}-{raw.views}-baked.png");
                            }
                        }
                        foreach (var result in new[] { raw, triangulated }) {
                            result.all.Finish();
                            result.seam.Finish();
                            result.interior.Finish();
                            results.Add(result);
                        }
                    }
                }
            }
        } finally {
            UnityEngine.Object.DestroyImmediate(cameraObject);
            UnityEngine.Object.DestroyImmediate(target);
            UnityEngine.Object.DestroyImmediate(pixels);
        }
        var report = new Report { unityVersion = Application.unityVersion, graphicsDevice = SystemInfo.graphicsDeviceName, results = results.ToArray() };
        File.WriteAllText("rebake-report.json", JsonUtility.ToJson(report, true));
        if (results.Count == 0) throw new InvalidOperationException("No rebake fixtures were compared.");
        foreach (var result in results.Where(result => result.pass == "Lit")) {
            if (result.seam.mae > 1.5f / 255f || result.seam.p95 > 5f / 255f ||
                (!paintedSource && result.fixture == "static" && result.seam.max > 12f / 255f)) {
                throw new InvalidOperationException($"Visible seam error exceeded the fixture budget in {result.fixture} versus {result.reference}.");
            }
            if (paintedSource && result.fixture == "static" && result.reference == "original" &&
                (result.paintCorePixels < 5000 || result.paintGaps != 0 || result.newBlackPixels != 0 || result.silhouetteDifferences != 0))
                throw new InvalidOperationException("The rebake lost paint coverage or introduced black pixels on the plate.");
        }
    }

    static void CountPaintCore(Result result, Color32[] source, Color32[] baked, int width)
    {
        bool Cyan(Color32 color, int redLimit, int greenLimit, int margin) =>
            color.r < redLimit && color.g > greenLimit && color.r + margin < color.g && color.r + margin < color.b;
        for (int y = 2; y < source.Length / width - 2; y++) for (int x = 2; x < width - 2; x++) {
            int i = y * width + x;
            var before = source[i];
            var after = baked[i];
            if (before.a > 0 && after.a > 0 && Math.Max(before.r, Math.Max(before.g, before.b)) > 50 &&
                Math.Max(after.r, Math.Max(after.g, after.b)) < 6) result.newBlackPixels++;
            if (!Cyan(before, 45, 100, 65)) continue;
            bool core = true;
            for (int dy = -2; dy <= 2 && core; dy++) for (int dx = -2; dx <= 2 && core; dx++)
                core = Cyan(source[i + dy * width + dx], 45, 100, 65);
            if (!core) continue;
            result.paintCorePixels++;
            if (!Cyan(after, 75, 78, 40)) result.paintGaps++;
        }
    }

    static Result NewResult(string fixture, string reference, string pass, CaptureModel baked) =>
        new Result { fixture = fixture, reference = reference, pass = pass, seamEdges = baked.seamEdges };

    static Color32[] Capture(CaptureModel model, Camera camera, Texture2D pixels)
    {
        model.model.SetActive(true);
        camera.Render();
        var previous = RenderTexture.active;
        RenderTexture.active = camera.targetTexture;
        pixels.ReadPixels(new Rect(0, 0, pixels.width, pixels.height), 0, 0, false);
        RenderTexture.active = previous;
        model.model.SetActive(false);
        return pixels.GetPixels32();
    }

    static void Compare(Result result, Color32[] before, Color32[] after)
    {
        result.views++;
        for (int i = 0; i < before.Length; i++) {
            var a = before[i];
            var b = after[i];
            if ((a.a == 0) != (b.a == 0)) result.silhouetteDifferences++;
            if (a.a == 0 || b.a == 0) continue;
            float delta = (Math.Abs(a.r - b.r) + Math.Abs(a.g - b.g) + Math.Abs(a.b - b.b)) / 765f;
            result.all.Add(delta);
            (b.a > 200 ? result.seam : result.interior).Add(delta);
        }
    }

    static void Write(Texture2D pixels, Color32[] colors, string path)
    {
        for (int i = 0; i < colors.Length; i++) colors[i].a = 255;
        pixels.SetPixels32(colors);
        pixels.Apply();
        File.WriteAllBytes(path, pixels.EncodeToPNG());
    }
}
