using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public sealed class E08TextureSettings : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith("Assets/Fixtures/", StringComparison.Ordinal)) return;
        var importer = (TextureImporter)assetImporter;
        importer.isReadable = true;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.wrapMode = TextureWrapMode.Clamp;
    }
}

public static class E08Probe
{
    [Serializable] sealed class Report
    {
        public string unityVersion;
        public int sourceTriangles, gridTriangles, smoothTriangles, projectedTriangles, colorSamples;
        public float existingPointError, rebakePointError, maximumColorError;
        public int tripoGridTriangles, tripoSmoothTriangles, weightedNewPoints, poseSamples;
        public float maxOriginalPoseDelta, maxNewPointPoseError, maxNewPointMotion;
    }

    sealed class Instance : IDisposable
    {
        readonly GameObject root;
        public readonly Mesh mesh;
        public readonly Vector3[] positions;
        public readonly Texture2D color;

        public Instance(string folder)
        {
            var path = Directory.GetFiles("Assets/Fixtures/" + folder, "*.fbx").Single().Replace('\\', '/');
            root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            var filter = root.GetComponentsInChildren<MeshFilter>().Single();
            mesh = filter.sharedMesh;
            color = filter.GetComponent<MeshRenderer>().sharedMaterial.mainTexture as Texture2D;
            if (color == null || mesh.uv.Length != mesh.vertexCount)
                throw new InvalidOperationException("Unity did not bind Base Color and UV0.");
            positions = mesh.vertices.Select(filter.transform.TransformPoint).ToArray();
        }

        public void Dispose() => UnityEngine.Object.DestroyImmediate(root);
    }

    public static void Run()
    {
        using (var source = new Instance("patch"))
        using (var grid = new Instance("patch-grid"))
        using (var smooth = new Instance("patch-smooth"))
        using (var projected = new Instance("patch-projected")) {
            float Match(Vector3[] a, Vector3[] b) => a.Max(p => b.Min(q => Vector3.Distance(p, q)));
            var existing = source.positions.Where(p => Math.Abs(p.x) > .5f || Math.Abs(p.y) > .5f).ToArray();
            var report = new Report {
                unityVersion = Application.unityVersion, sourceTriangles = source.mesh.triangles.Length / 3,
                gridTriangles = grid.mesh.triangles.Length / 3, smoothTriangles = smooth.mesh.triangles.Length / 3,
                projectedTriangles = projected.mesh.triangles.Length / 3,
                existingPointError = Mathf.Max(Match(existing, grid.positions), Match(existing, smooth.positions)),
                rebakePointError = Mathf.Max(Match(smooth.positions, projected.positions), Match(projected.positions, smooth.positions)),
            };
            var triangles = projected.mesh.triangles;
            var uv = projected.mesh.uv;
            for (int i = 0; i < triangles.Length; i += 3) {
                int a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
                var point = (projected.positions[a] + projected.positions[b] + projected.positions[c]) / 3;
                if (Math.Abs(point.x) >= .94f || Math.Abs(point.y) >= .94f) continue;
                var mapped = (uv[a] + uv[b] + uv[c]) / 3;
                var original = SourceUV(source, point);
                var before = source.color.GetPixelBilinear(original.x, original.y);
                var after = projected.color.GetPixelBilinear(mapped.x, mapped.y);
                if (after.a < .99f) throw new InvalidOperationException("A repaired interior texel was unpainted by the projection.");
                report.maximumColorError = Mathf.Max(report.maximumColorError,
                    Mathf.Max(Math.Abs(before.r - after.r), Math.Abs(before.g - after.g), Math.Abs(before.b - after.b)));
                report.colorSamples++;
            }
            if (Directory.Exists("Assets/Fixtures/tripo")) VerifyPlate(report);
            if (Directory.Exists("Assets/Fixtures/skin")) VerifySkin(report);
            File.WriteAllText("e08-report.json", JsonUtility.ToJson(report, true));
            if (report.sourceTriangles != 32 || report.gridTriangles != 32 || report.smoothTriangles <= 32 ||
                report.smoothTriangles != report.projectedTriangles || projected.color.width != 256 ||
                report.existingPointError > 2e-6f || report.rebakePointError > 2e-6f ||
                report.colorSamples < 24 || report.maximumColorError > .08f)
                throw new InvalidOperationException("The FBX repair or the projected atlas failed its fixture tolerance.");
        }
    }

    static void VerifyPlate(Report report)
    {
        using (var grid = new Instance("tripo-grid"))
        using (var smooth = new Instance("tripo-smooth")) {
            report.tripoGridTriangles = grid.mesh.triangles.Length / 3;
            report.tripoSmoothTriangles = smooth.mesh.triangles.Length / 3;
            if (report.tripoGridTriangles != 9138 || report.tripoSmoothTriangles <= 9138)
                throw new InvalidOperationException("Unity did not import both Tripo plate repairs.");
        }
    }

    static void VerifySkin(Report report)
    {
        (GameObject root, SkinnedMeshRenderer skin, AnimationClip clip) Import(string folder)
        {
            var path = Directory.GetFiles("Assets/Fixtures/" + folder, "*.fbx").Single().Replace('\\', '/');
            var root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            var clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                .Single(asset => asset.name == "Bend");
            return (root, root.GetComponentInChildren<SkinnedMeshRenderer>(), clip);
        }
        Vector3[] Bake(SkinnedMeshRenderer skin, Mesh storage)
        {
            skin.BakeMesh(storage, false);
            return storage.vertices.Select(skin.transform.TransformPoint).ToArray();
        }
        var before = Import("skin");
        var after = Import("skin-smooth");
        var scratch = new Mesh();
        try {
            var original = before.skin.sharedMesh.vertices;
            var edited = after.skin.sharedMesh.vertices;
            var weights = after.skin.sharedMesh.boneWeights;
            var bind = after.skin.sharedMesh.bindposes;
            var added = Enumerable.Range(0, edited.Length).Where(i => original.All(p => Vector3.Distance(p, edited[i]) > 2e-5f)).ToArray();
            var matched = original.Select(p => Array.FindIndex(edited, q => Vector3.Distance(p, q) <= 2e-5f)).ToArray();
            var rest = Bake(after.skin, scratch);
            if (matched.Any(i => i < 0) || added.Length == 0 || after.skin.bones.Length != 2 ||
                Mathf.Abs(before.clip.length - after.clip.length) > 2e-5f)
                throw new InvalidOperationException("The animated Smooth fill lost its original points, shape, or clip.");
            foreach (int i in added) {
                var w = weights[i];
                if (Mathf.Abs(w.weight0 + w.weight1 + w.weight2 + w.weight3 - 1f) > 2e-5f)
                    throw new InvalidOperationException("An inserted Smooth point has unnormalized skin weights.");
            }
            report.weightedNewPoints = added.Length;
            for (int sample = 0; sample <= 20; sample++) {
                before.clip.SampleAnimation(before.root, sample * before.clip.length / 20f);
                after.clip.SampleAnimation(after.root, sample * after.clip.length / 20f);
                var a = Bake(before.skin, scratch);
                var b = Bake(after.skin, scratch);
                for (int i = 0; i < matched.Length; i++)
                    report.maxOriginalPoseDelta = Mathf.Max(report.maxOriginalPoseDelta, Vector3.Distance(a[i], b[matched[i]]));
                foreach (int i in added) {
                    var w = weights[i];
                    Vector3 At(int joint, float weight) => weight <= 0 ? Vector3.zero :
                        (after.skin.bones[joint].localToWorldMatrix * bind[joint]).MultiplyPoint3x4(edited[i]) * weight;
                    var expected = At(w.boneIndex0, w.weight0) + At(w.boneIndex1, w.weight1) +
                        At(w.boneIndex2, w.weight2) + At(w.boneIndex3, w.weight3);
                    report.maxNewPointPoseError = Mathf.Max(report.maxNewPointPoseError, Vector3.Distance(expected, b[i]));
                    report.maxNewPointMotion = Mathf.Max(report.maxNewPointMotion, Vector3.Distance(rest[i], b[i]));
                }
                report.poseSamples++;
            }
            if (report.maxOriginalPoseDelta > 2e-5f || report.maxNewPointPoseError > 2e-5f || report.maxNewPointMotion < .005f)
                throw new InvalidOperationException("The original or inserted Smooth surface deformed incorrectly.");
        } finally {
            UnityEngine.Object.DestroyImmediate(before.root);
            UnityEngine.Object.DestroyImmediate(after.root);
            UnityEngine.Object.DestroyImmediate(scratch);
        }
    }

    static Vector2 SourceUV(Instance source, Vector3 p)
    {
        var t = source.mesh.triangles;
        var uv = source.mesh.uv;
        for (int i = 0; i < t.Length; i += 3) {
            var a = source.positions[t[i]];
            var e = source.positions[t[i + 1]] - a;
            var f = source.positions[t[i + 2]] - a;
            var q = p - a;
            float det = e.x * f.y - e.y * f.x;
            if (Math.Abs(det) < 1e-8f) continue;
            float v = (q.x * f.y - q.y * f.x) / det;
            float w = (e.x * q.y - e.y * q.x) / det;
            if (v >= -1e-5f && w >= -1e-5f && v + w <= 1.00001f)
                return (1 - v - w) * uv[t[i]] + v * uv[t[i + 1]] + w * uv[t[i + 2]];
        }
        throw new InvalidOperationException("A repaired face has no reference point.");
    }
}
