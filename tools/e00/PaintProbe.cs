using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public static class PaintProbe
{
    [Serializable] sealed class Stroke
    {
        public Sample[] samples;
        public int[] crossings;
        public Lane[] lanes;
        public string color;
    }

    [Serializable] sealed class Lane
    {
        public Sample[] samples;
        public int[] crossings;
    }

    [Serializable] sealed class Sample
    {
        public float u, v;
    }

    [Serializable] sealed class Result
    {
        public string unityVersion, graphicsDevice;
        public int sampledSurfacePoints, newSeamCrossings, centerlineSamples, centerlineGaps, seamSamples, seamGaps;
        public int bandSamples, bandGaps, bandFilteredSamples, undersidePixels, changedUndersidePixels, maxUndersideRgbDifference;
        public float minSeamCoverage = 1, minBandCoverage = 1;
    }

    sealed class Plate : IDisposable
    {
        public readonly GameObject root;
        public readonly MeshFilter filter;
        public readonly Renderer renderer;
        readonly Material material;

        public Plate(string directory, Shader shader)
        {
            var path = Directory.GetFiles(directory, "*.fbx").Single().Replace('\\', '/');
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) throw new InvalidOperationException($"Unity did not import {path}.");
            root = UnityEngine.Object.Instantiate(prefab);
            filter = root.GetComponentInChildren<MeshFilter>();
            renderer = filter.GetComponent<Renderer>();
            var color = renderer.sharedMaterial.GetTexture("_MainTex");
            if (color == null) throw new InvalidOperationException($"Base Color was not linked in {path}.");
            material = new Material(shader);
            material.SetTexture("_MainTex", color);
            material.SetFloat("_Mode", 1);
            renderer.sharedMaterial = material;
            root.SetActive(false);
        }

        public Vector3[] SurfacePoints(Sample[] samples)
        {
            var mesh = filter.sharedMesh;
            var uv = mesh.uv;
            var vertices = mesh.vertices;
            var triangles = mesh.triangles;
            var points = new Vector3[samples.Length];
            if (uv.Length != vertices.Length || mesh.uv2.Length != vertices.Length) {
                throw new InvalidOperationException("The imported plate must have both UV channels.");
            }
            for (int s = 0; s < samples.Length; s++) {
                var sample = new Vector2(samples[s].u, samples[s].v);
                bool found = false;
                for (int i = 0; i < triangles.Length; i += 3) {
                    int ia = triangles[i], ib = triangles[i + 1], ic = triangles[i + 2];
                    Vector2 e = uv[ib] - uv[ia], f = uv[ic] - uv[ia], p = sample - uv[ia];
                    var determinant = e.x * f.y - e.y * f.x;
                    if (Mathf.Abs(determinant) < 1e-12f) continue;
                    var b = (p.x * f.y - p.y * f.x) / determinant;
                    var c = (e.x * p.y - e.y * p.x) / determinant;
                    var a = 1 - b - c;
                    if (a < -1e-4f || b < -1e-4f || c < -1e-4f) continue;
                    points[s] = filter.transform.TransformPoint(a * vertices[ia] + b * vertices[ib] + c * vertices[ic]);
                    found = true;
                    break;
                }
                if (!found) throw new InvalidOperationException($"The imported atlas did not contain stroke sample {s}.");
            }
            return points;
        }

        public void Dispose()
        {
            UnityEngine.Object.DestroyImmediate(root);
            UnityEngine.Object.DestroyImmediate(material);
        }
    }

    public static void Run()
    {
        var shader = Shader.Find("Hidden/AssetFixer/TextureBakeProbe");
        if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null || shader == null || !shader.isSupported) {
            throw new InvalidOperationException("The brush probe requires the Unity diagnostic shader and a graphics device.");
        }
        var stroke = JsonUtility.FromJson<Stroke>(File.ReadAllText("ceramic-plate-stroke.json"));
        if (stroke.samples.Length < 2 || stroke.crossings.Length == 0) throw new InvalidOperationException("The test stroke must cross a new UV seam.");
        if (!ColorUtility.TryParseHtmlString(stroke.color, out Color brush)) throw new InvalidOperationException("A test brush color is required.");
        Color32 brushColor = brush;
        var result = new Result { unityVersion = Application.unityVersion, graphicsDevice = SystemInfo.graphicsDeviceName,
            sampledSurfacePoints = stroke.samples.Length, newSeamCrossings = stroke.crossings.Length };
        var cameraObject = new GameObject("Paint verification", typeof(Camera));
        var camera = cameraObject.GetComponent<Camera>();
        camera.orthographic = true;
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(0.07f, 0.08f, 0.1f, 0);
        camera.allowHDR = camera.allowMSAA = false;
        camera.nearClipPlane = 0.01f;
        camera.farClipPlane = 20;
        const int size = 768;
        var target = new RenderTexture(size, size, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear);
        var texture = new Texture2D(size, size, TextureFormat.RGBA32, false, true);
        camera.targetTexture = target;
        Directory.CreateDirectory("captures");
        try {
            using (var source = new Plate("Assets/Fixtures/static/reference", shader))
            using (var painted = new Plate("Assets/Fixtures/static/exported", shader)) {
                var bounds = painted.renderer.bounds;
                camera.orthographicSize = bounds.size.magnitude * 0.43f;
                camera.transform.position = bounds.center + 2 * Vector3.up;
                camera.transform.LookAt(bounds.center, Vector3.forward);
                var original = Render(source, camera, texture);
                var frontal = Render(painted, camera, texture);
                void Measure(Sample[] samples, int[] crossings, bool center) =>
                    MeasureLine(painted.SurfacePoints(samples).Select(camera.WorldToScreenPoint).ToArray(),
                        crossings, frontal, original, brushColor, size, center, result);
                Measure(stroke.samples, stroke.crossings, true);
                foreach (var lane in stroke.lanes) Measure(lane.samples, lane.crossings, false);
                Write(texture, original, "captures/plate-before.png");
                Write(texture, frontal, "captures/plate-painted.png");
                camera.transform.position = bounds.center + 2 * Vector3.down;
                camera.transform.LookAt(bounds.center, Vector3.forward);
                var beforeBack = Render(source, camera, texture);
                var afterBack = Render(painted, camera, texture);
                for (int i = 0; i < afterBack.Length; i++) {
                    if (beforeBack[i].a == 0 && afterBack[i].a == 0) continue;
                    result.undersidePixels++;
                    if (!beforeBack[i].Equals(afterBack[i])) result.changedUndersidePixels++;
                    var a = beforeBack[i]; var b = afterBack[i];
                    result.maxUndersideRgbDifference = Math.Max(result.maxUndersideRgbDifference,
                        Math.Max(Math.Abs(a.r - b.r), Math.Max(Math.Abs(a.g - b.g), Math.Abs(a.b - b.b))));
                }
                Write(texture, afterBack, "captures/plate-underside.png");
            }
        } finally {
            camera.targetTexture = null;
            UnityEngine.Object.DestroyImmediate(texture);
            UnityEngine.Object.DestroyImmediate(target);
            UnityEngine.Object.DestroyImmediate(cameraObject);
        }
        File.WriteAllText("paint-report.json", JsonUtility.ToJson(result, true));
        if (result.centerlineGaps != 0 || result.bandGaps != 0 || result.seamGaps != 0 || result.seamSamples == 0 ||
            result.undersidePixels == 0 || result.changedUndersidePixels != 0) {
            throw new InvalidOperationException("The brush render has a gap or changed the underside. See paint-report.json.");
        }
    }

    static void MeasureLine(Vector3[] points, int[] crossings, Color32[] painted, Color32[] original, Color32 brush,
        int size, bool center, Result result)
    {
        for (int i = 1; i < points.Length; i++) {
            var a = points[i - 1];
            var b = points[i];
            bool seam = Array.Exists(crossings, crossing => Math.Abs(crossing - i) <= 2);
            int steps = Math.Max(1, Mathf.CeilToInt(2 * Vector2.Distance(a, b)));
            for (int step = 0; step <= steps; step++) {
                var p = Vector3.Lerp(a, b, (float)step / steps);
                int index = Mathf.FloorToInt(p.y) * size + Mathf.FloorToInt(p.x);
                float coverage = BrushCoverage(original[index], painted[index], brush);
                if (center) {
                    result.centerlineSamples++;
                    if (coverage < 0.70f) result.centerlineGaps++;
                } else {
                    result.bandSamples++;
                    result.minBandCoverage = Mathf.Min(result.minBandCoverage, coverage);
                    // Away from the seam center, a mip-filtered sample can mix the
                    // brush with the base color. Require a measurable stroke there.
                    if (coverage < 0.25f) result.bandGaps++;
                    if (coverage < 0.70f) result.bandFilteredSamples++;
                }
                if (seam) {
                    result.seamSamples++;
                    result.minSeamCoverage = Mathf.Min(result.minSeamCoverage, coverage);
                    if (coverage < 0.70f) result.seamGaps++;
                }
            }
        }
    }

    static float BrushCoverage(Color32 original, Color32 painted, Color32 brush)
    {
        if (original.a == 0 || painted.a == 0) return 0;
        var expected = new Vector3(brush.r - original.r, brush.g - original.g, brush.b - original.b);
        if (expected.sqrMagnitude < 1) return 0;
        var observed = new Vector3(painted.r - original.r, painted.g - original.g, painted.b - original.b);
        return Mathf.Clamp01(Vector3.Dot(expected, observed) / expected.sqrMagnitude);
    }

    static Color32[] Render(Plate plate, Camera camera, Texture2D texture)
    {
        plate.root.SetActive(true);
        camera.Render();
        var previous = RenderTexture.active;
        RenderTexture.active = camera.targetTexture;
        texture.ReadPixels(new Rect(0, 0, texture.width, texture.height), 0, 0, false);
        RenderTexture.active = previous;
        plate.root.SetActive(false);
        return texture.GetPixels32();
    }

    static void Write(Texture2D texture, Color32[] colors, string path)
    {
        for (int i = 0; i < colors.Length; i++) colors[i].a = 255;
        texture.SetPixels32(colors);
        texture.Apply();
        File.WriteAllBytes(path, texture.EncodeToPNG());
    }
}
