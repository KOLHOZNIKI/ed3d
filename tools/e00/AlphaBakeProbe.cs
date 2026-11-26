using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using Manifest = AssetFixerAlphaMaterialImporter.Manifest;
using MaterialProfile = AssetFixerAlphaMaterialImporter.Profile;

public sealed class E00AlphaTextureSettings : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith("Assets/Fixtures/", StringComparison.Ordinal)) return;
        var importer = (TextureImporter)assetImporter;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.maxTextureSize = 4096;
        importer.mipmapEnabled = true;
        importer.filterMode = FilterMode.Trilinear;
        importer.alphaSource = TextureImporterAlphaSource.FromInput;
        importer.alphaIsTransparency = false;
        importer.isReadable = true;
        importer.wrapModeU = assetPath.Contains("/original/") ? TextureWrapMode.Repeat : TextureWrapMode.Clamp;
        importer.wrapModeV = TextureWrapMode.Clamp;
    }
}

public static class AlphaBakeProbe
{
    [Serializable] sealed class Report
    {
        public string unityVersion, graphicsDevice, colorSpace;
        public Result[] results;
    }

    [Serializable] sealed class Result
    {
        public string mode;
        public int atlasWidth, atlasHeight, interiorTexelSamples, hiddenRgbSamples, maxInteriorRgbaError;
        public int surfacePixels, fullyTransparentPixels, fullyOpaquePixels, partialPixels, alpha64Pixels, alpha140Pixels;
        public int interiorOpacityPixels, maxInteriorOpacityError;
        public float importedMode, meanCompositeRgbError, meanRenderedOpacityError, ignoredTransformError;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject root;
        public readonly Mesh mesh;
        public readonly Renderer renderer;
        public readonly Material material;
        public readonly Texture2D texture;
        public readonly MaterialProfile profile;
        public readonly Vector2[] originalUv;
        public readonly float importedMode;

        public Model(string directory)
        {
            var manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(Path.Combine(directory, "manifest.json")));
            profile = manifest.assetFixerMaterial;
            string path = Path.Combine(directory, manifest.model).Replace('\\', '/');
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            Require(prefab != null, $"Unity did not import {path}.");
            root = UnityEngine.Object.Instantiate(prefab);
            var filter = root.GetComponentInChildren<MeshFilter>();
            renderer = filter.GetComponent<MeshRenderer>();
            material = new Material(renderer.sharedMaterial);
            Require(material.shader.name == "Standard", "The probe requires the built-in Unity Standard material.");
            texture = material.GetTexture("_MainTex") as Texture2D;
            Require(texture != null && material.GetTextureScale("_MainTex") == Vector2.one &&
                material.GetTextureOffset("_MainTex") == Vector2.zero, "The FBX must link its Base Color with identity native UV settings.");
            importedMode = material.GetFloat("_Mode");
            if (profile.uvTransform != null) AssetFixerAlphaMaterialImporter.Apply(material, profile);
            else {
                bool mask = profile.alphaMode == "mask";
                Require(importedMode == (mask ? 1 : 2) && material.IsKeywordEnabled(mask ? "_ALPHATEST_ON" : "_ALPHABLEND_ON") &&
                    (!mask || Mathf.Approximately(material.GetFloat("_Cutoff"), profile.alphaCutoff)),
                    $"Unity did not apply the exported alpha mode from {path}'s manifest.");
            }
            renderer.sharedMaterial = material;
            mesh = UnityEngine.Object.Instantiate(filter.sharedMesh);
            filter.sharedMesh = mesh;
            originalUv = mesh.uv;
            root.SetActive(false);
        }

        public void Dispose()
        {
            UnityEngine.Object.DestroyImmediate(root);
            UnityEngine.Object.DestroyImmediate(mesh);
            UnityEngine.Object.DestroyImmediate(material);
        }
    }

    // Independent reference for the generator's named scale, rotation and offset.
    static Vector2 ReferenceUv(Vector2 uv)
    {
        float angle = 27 * Mathf.Deg2Rad;
        float u = uv.x * 1.25f, v = uv.y * 0.82f;
        return new Vector2(u * Mathf.Cos(angle) - v * Mathf.Sin(angle) + 0.17f,
            u * Mathf.Sin(angle) + v * Mathf.Cos(angle) - 0.12f);
    }

    public static void Run()
    {
        Require(SystemInfo.graphicsDeviceType != GraphicsDeviceType.Null, "The probe requires a graphics device.");
        Directory.CreateDirectory("captures");
        RenderSettings.ambientMode = AmbientMode.Flat;
        RenderSettings.ambientLight = new Color(0.8f, 0.8f, 0.8f);
        var lightObject = new GameObject("Reference lighting", typeof(Light));
        var light = lightObject.GetComponent<Light>();
        light.type = LightType.Directional;
        light.intensity = 0.55f;
        light.transform.rotation = Quaternion.LookRotation(new Vector3(-0.25f, -0.15f, -1));

        var cameraObject = new GameObject("Alpha Bake Camera", typeof(Camera));
        var camera = cameraObject.GetComponent<Camera>();
        const int size = 640;
        camera.orthographic = true;
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.allowHDR = false;
        camera.allowMSAA = false;
        var target = new RenderTexture(size, size, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear);
        var frame = new Texture2D(size, size, TextureFormat.RGBA32, false, true);
        camera.targetTexture = target;
        try {
            var results = Directory.GetDirectories("Assets/Fixtures").OrderBy(path => path).Select(folder => {
                using (var source = new Model(Path.Combine(folder, "original")))
                using (var baked = new Model(Path.Combine(folder, "exported"))) {
                    return Compare(source, baked, camera, frame);
                }
            }).ToArray();
            Require(results.Length == 2, "Expected both Cutout and Fade fixtures.");
            var report = new Report { unityVersion = Application.unityVersion, graphicsDevice = SystemInfo.graphicsDeviceName,
                colorSpace = QualitySettings.activeColorSpace.ToString(), results = results };
            File.WriteAllText("alpha-report.json", JsonUtility.ToJson(report, true));
            foreach (var result in results) {
                Require(result.interiorTexelSamples >= 400 && result.hiddenRgbSamples > 0 && result.maxInteriorRgbaError <= 1,
                    $"{result.mode} lost interior RGBA samples. See alpha-report.json.");
                Require(result.interiorOpacityPixels > 10000 && result.maxInteriorOpacityError <= 2 &&
                    result.fullyTransparentPixels > 1000 && result.fullyOpaquePixels > 1000 &&
                    result.meanRenderedOpacityError < 2 && result.meanCompositeRgbError < 3 && result.ignoredTransformError > 10,
                    $"{result.mode} did not preserve the rendered pattern or transparency. See alpha-report.json.");
                if (result.mode == "mask") Require(result.partialPixels == 0, "The mask must render binary opacity.");
                else Require(result.alpha64Pixels > 1000 && result.alpha140Pixels > 1000, "Fade must retain both partially transparent levels.");
            }
        } finally {
            camera.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(frame);
            UnityEngine.Object.DestroyImmediate(target);
            UnityEngine.Object.DestroyImmediate(cameraObject);
            UnityEngine.Object.DestroyImmediate(lightObject);
        }
    }

    static Result Compare(Model source, Model baked, Camera camera, Texture2D frame)
    {
        string mode = source.profile.alphaMode;
        Require(mode == baked.profile.alphaMode && source.profile.alphaCutoff == baked.profile.alphaCutoff &&
            source.profile.uvTransform?.Length == 6 && baked.profile.uvTransform == null, "The manifest must preserve the alpha rule and consume the transform exactly once.");
        var m = source.profile.uvTransform;
        foreach (var uv in new[] { Vector2.zero, Vector2.right, Vector2.up, Vector2.one }) {
            var actual = new Vector2(m[0] * uv.x + m[1] * uv.y + m[2], m[3] * uv.x + m[4] * uv.y + m[5]);
            Require(Vector2.Distance(actual, ReferenceUv(uv)) < 1e-6f, "Unexpected fixture transform.");
        }
        var result = new Result { mode = mode, atlasWidth = baked.texture.width, atlasHeight = baked.texture.height,
            importedMode = baked.importedMode };
        MeasureInterior(source, baked, result);

        var bounds = source.renderer.bounds;
        camera.orthographicSize = 0.84f * bounds.size.magnitude / 2;
        camera.transform.position = bounds.center + new Vector3(0.24f, 0.12f, 1) * 4;
        camera.transform.LookAt(bounds.center);
        var backdrop = new Color(0.08f, 0.17f, 0.29f);
        var untransformed = Capture(source, camera, frame, backdrop);
        source.mesh.uv = source.originalUv.Select(ReferenceUv).ToArray();
        var before = Capture(source, camera, frame, backdrop);
        var after = Capture(baked, camera, frame, backdrop);
        var originalAlpha = Opacity(Capture(source, camera, frame, Color.black), Capture(source, camera, frame, Color.white));
        var bakedAlpha = Opacity(Capture(baked, camera, frame, Color.black), Capture(baked, camera, frame, Color.white));

        var solid = new Material(Shader.Find("Unlit/Color")) { color = Color.white };
        source.renderer.sharedMaterial = solid;
        var coverage = Capture(source, camera, frame, Color.black);
        source.renderer.sharedMaterial = source.material;
        UnityEngine.Object.DestroyImmediate(solid);
        double rgb = 0, alpha = 0, control = 0;
        int width = frame.width;
        for (int i = 0; i < coverage.Length; i++) {
            if (coverage[i].r < 240) continue;
            result.surfacePixels++;
            int a = originalAlpha[i], b = bakedAlpha[i];
            rgb += RgbDelta(before[i], after[i]);
            control += RgbDelta(before[i], untransformed[i]);
            alpha += Math.Abs(a - b);
            if (b <= 1) result.fullyTransparentPixels++;
            else if (b >= 254) result.fullyOpaquePixels++;
            else result.partialPixels++;
            if (Math.Abs(b - 64) <= 2) result.alpha64Pixels++;
            if (Math.Abs(b - 140) <= 2) result.alpha140Pixels++;
            int x = i % width, y = i / width;
            if (x < 2 || x >= width - 2 || y < 2 || y >= frame.height - 2) continue;
            bool interior = true;
            for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
                int neighbor = i + dy * width + dx;
                interior &= coverage[neighbor].r >= 240 && Math.Abs(originalAlpha[neighbor] - a) <= 1;
            }
            if (!interior) continue;
            result.interiorOpacityPixels++;
            result.maxInteriorOpacityError = Math.Max(result.maxInteriorOpacityError, Math.Abs(a - b));
        }
        Require(result.surfacePixels > 0, "The fixture was outside the camera.");
        result.meanCompositeRgbError = (float)(rgb / result.surfacePixels);
        result.meanRenderedOpacityError = (float)(alpha / result.surfacePixels);
        result.ignoredTransformError = (float)(control / result.surfacePixels);
        Write(frame, before, $"captures/{mode}-original.png");
        Write(frame, after, $"captures/{mode}-baked.png");
        return result;
    }

    static void MeasureInterior(Model source, Model baked, Result result)
    {
        var triangles = baked.mesh.triangles;
        var oldUv = baked.mesh.uv2;
        Require(oldUv.Length == baked.originalUv.Length, "The baked mesh must retain the original UV channel.");
        float pixel = 3f / source.texture.width;
        for (int triangle = 0; triangle < triangles.Length; triangle += 3) {
            int a = triangles[triangle], b = triangles[triangle + 1], c = triangles[triangle + 2];
            for (int i = 1; i < 32; i++) for (int j = 1; i + j < 32; j++) {
                float u = i / 32f, v = j / 32f, w = 1 - u - v;
                var reference = ReferenceUv(oldUv[a] * w + oldUv[b] * u + oldUv[c] * v);
                var target = baked.originalUv[a] * w + baked.originalUv[b] * u + baked.originalUv[c] * v;
                Color32 expected = source.texture.GetPixelBilinear(reference.x, reference.y);
                bool uniform = true;
                for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
                    Color32 neighbor = source.texture.GetPixelBilinear(reference.x + dx * pixel, reference.y + dy * pixel);
                    uniform &= expected.Equals(neighbor);
                }
                if (!uniform) continue;
                Color32 actual = baked.texture.GetPixelBilinear(target.x, target.y);
                result.interiorTexelSamples++;
                if (expected.a == 0 && expected.r + expected.g + expected.b > 0) result.hiddenRgbSamples++;
                result.maxInteriorRgbaError = Math.Max(result.maxInteriorRgbaError, RgbaDelta(expected, actual));
            }
        }
    }

    static Color32[] Capture(Model model, Camera camera, Texture2D frame, Color background)
    {
        model.root.SetActive(true);
        camera.backgroundColor = background;
        camera.Render();
        var previous = RenderTexture.active;
        RenderTexture.active = camera.targetTexture;
        frame.ReadPixels(new Rect(0, 0, frame.width, frame.height), 0, 0, false);
        RenderTexture.active = previous;
        model.root.SetActive(false);
        return frame.GetPixels32();
    }

    static int[] Opacity(Color32[] dark, Color32[] light) => dark.Zip(light, (a, b) => Mathf.Clamp(
        255 - Mathf.RoundToInt(((b.r - a.r) + (b.g - a.g) + (b.b - a.b)) / 3f), 0, 255)).ToArray();

    static int RgbaDelta(Color32 a, Color32 b) => Math.Max(Math.Max(Math.Abs(a.r - b.r), Math.Abs(a.g - b.g)),
        Math.Max(Math.Abs(a.b - b.b), Math.Abs(a.a - b.a)));

    static float RgbDelta(Color32 a, Color32 b) => (Math.Abs(a.r - b.r) + Math.Abs(a.g - b.g) + Math.Abs(a.b - b.b)) / 3f;

    static void Write(Texture2D frame, Color32[] colors, string path)
    {
        for (int i = 0; i < colors.Length; i++) colors[i].a = 255;
        frame.SetPixels32(colors);
        frame.Apply();
        File.WriteAllBytes(path, frame.EncodeToPNG());
    }

    static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
