using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class AdverseSkinProbe
{
    const float Tolerance = 1e-5f;
    static readonly float[] ExpectedWeights = { 0.3125f, 0.25f, 0.1875f, 0.15625f, 0.09375f };

    [Serializable] sealed class Report
    {
        public string unityVersion;
        public bool compatible;
        public int originalFiveInfluenceVertices, exportedFiveInfluenceVertices, morphSourceFiveInfluenceVertices, samples;
        public string[] morphNames;
        public float[] morphMaxDeltas;
        public float maxWeightDelta, maxPoseError, sourceFifthInfluenceMotion;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject root;
        public readonly SkinnedMeshRenderer renderer;
        public readonly AnimationClip clip;
        public Mesh Mesh => renderer.sharedMesh;

        public Model(string directory)
        {
            var path = Directory.GetFiles(directory, "*.fbx").Single().Replace('\\', '/');
            var importer = (ModelImporter)AssetImporter.GetAtPath(path);
            if (importer.skinWeights != ModelImporterSkinWeights.Custom || importer.maxBonesPerVertex != 8)
                throw new InvalidOperationException($"Expected an eight-influence Unity import for {path}.");
            root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            renderer = root.GetComponentsInChildren<SkinnedMeshRenderer>().Single();
            renderer.quality = SkinQuality.Auto;
            clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                .Single(take => take.name == "FifthInfluenceBend");
        }

        public Vector3[] Points(Mesh mesh) => mesh.vertices.Select(renderer.transform.TransformPoint).ToArray();
        public void Dispose() => UnityEngine.Object.DestroyImmediate(root);
    }

    public static void Run()
    {
        var quality = QualitySettings.skinWeights;
        QualitySettings.skinWeights = SkinWeights.Unlimited;
        try {
            using (var original = new Model("Assets/Fixtures/adverse-skin/original"))
            using (var exported = new Model("Assets/Fixtures/adverse-skin/exported"))
            using (var morphs = new Model("Assets/Fixtures/adverse-morphs/original")) {
                var report = Compare(original, exported, morphs);
                File.WriteAllText("adverse-skin-report.json", JsonUtility.ToJson(report, true));
                if (!report.compatible) throw new InvalidOperationException("F13 Unity verification failed. See adverse-skin-report.json.");
                Debug.Log("Verified F13 source morphs and the five-influence export in Unity.");
            }
        } finally {
            QualitySettings.skinWeights = quality;
        }
    }

    static Report Compare(Model original, Model exported, Model morphs)
    {
        var report = new Report { unityVersion = Application.unityVersion };
        var sourceWeights = ReadWeights(original);
        var exportedWeights = ReadWeights(exported);
        var sourceMorphWeights = ReadWeights(morphs);
        var wideVertices = Array.FindAll(Enumerable.Range(0, sourceWeights.Length).ToArray(), i => sourceWeights[i].Count == 5);
        report.originalFiveInfluenceVertices = wideVertices.Length;
        report.exportedFiveInfluenceVertices = exportedWeights.Count(weights => weights.Count == 5);
        report.morphSourceFiveInfluenceVertices = sourceMorphWeights.Count(weights => weights.Count == 5);
        if (wideVertices.Length != 2 || report.exportedFiveInfluenceVertices != 2 || report.morphSourceFiveInfluenceVertices != 2 ||
            original.Mesh.blendShapeCount != 0 || exported.Mesh.blendShapeCount != 0 || morphs.Mesh.blendShapeCount != 2) return report;

        var shapeIndices = Enumerable.Range(0, morphs.Mesh.blendShapeCount).ToArray();
        report.morphNames = shapeIndices.Select(morphs.Mesh.GetBlendShapeName).ToArray();
        report.morphMaxDeltas = shapeIndices.Select(shape => {
            var delta = new Vector3[morphs.Mesh.vertexCount];
            morphs.Mesh.GetBlendShapeFrameVertices(shape, 0, delta, null, null);
            return delta.Max(point => point.magnitude);
        }).ToArray();
        if (!report.morphNames.Select((name, index) => name.EndsWith("Raise", StringComparison.Ordinal) &&
                Mathf.Abs(report.morphMaxDeltas[index] - 0.25f) <= Tolerance).Any(match => match) ||
            !report.morphNames.Select((name, index) => name.EndsWith("Widen", StringComparison.Ordinal) &&
                Mathf.Abs(report.morphMaxDeltas[index] - 0.1875f) <= Tolerance).Any(match => match)) return report;

        var a = original.Points(original.Mesh);
        var b = exported.Points(exported.Mesh);
        if (a.Length != b.Length) return report;
        var map = a.Select(point => Array.FindIndex(b, candidate => Vector3.Distance(point, candidate) <= Tolerance)).ToArray();
        if (map.Any(index => index < 0) || map.Distinct().Count() != a.Length) return report;
        for (int i = 0; i < sourceWeights.Length; i++) {
            var targetWeights = exportedWeights[map[i]];
            if (sourceWeights[i].Count != targetWeights.Count) return report;
            foreach (var weight in sourceWeights[i]) {
                if (!targetWeights.TryGetValue(weight.Key, out float value)) return report;
                report.maxWeightDelta = Mathf.Max(report.maxWeightDelta, Mathf.Abs(weight.Value - value));
            }
        }
        foreach (var weights in sourceWeights.Concat(sourceMorphWeights).Where(weights => weights.Count == 5)) {
            for (int i = 0; i < ExpectedWeights.Length; i++)
                if (!weights.TryGetValue($"Joint{i + 1}", out float value) || Mathf.Abs(value - ExpectedWeights[i]) > 2e-5f) return report;
        }

        var bakedA = new Mesh();
        var bakedB = new Mesh();
        try {
            Vector3[] rest = null;
            for (int sample = 0; sample <= 20; sample++) {
                original.clip.SampleAnimation(original.root, original.clip.length * sample / 20f);
                exported.clip.SampleAnimation(exported.root, exported.clip.length * sample / 20f);
                original.renderer.BakeMesh(bakedA, false);
                exported.renderer.BakeMesh(bakedB, false);
                var pose = original.Points(bakedA);
                var target = exported.Points(bakedB);
                if (sample == 0) rest = pose;
                for (int i = 0; i < pose.Length; i++)
                    report.maxPoseError = Mathf.Max(report.maxPoseError, Vector3.Distance(pose[i], target[map[i]]));
                foreach (int index in wideVertices)
                    report.sourceFifthInfluenceMotion = Mathf.Max(report.sourceFifthInfluenceMotion, Vector3.Distance(pose[index], rest[index]));
                report.samples++;
            }
        } finally {
            UnityEngine.Object.DestroyImmediate(bakedA);
            UnityEngine.Object.DestroyImmediate(bakedB);
        }
        report.compatible = report.maxWeightDelta <= 1e-6f && report.maxPoseError <= Tolerance && report.sourceFifthInfluenceMotion > 0.01f;
        return report;
    }

    static Dictionary<string, float>[] ReadWeights(Model model)
    {
        var bones = model.renderer.bones;
        var counts = model.Mesh.GetBonesPerVertex();
        var all = model.Mesh.GetAllBoneWeights();
        var result = new Dictionary<string, float>[counts.Length];
        int index = 0;
        for (int vertex = 0; vertex < counts.Length; vertex++) {
            var weights = new Dictionary<string, float>();
            for (int slot = 0; slot < counts[vertex]; slot++) {
                var weight = all[index++];
                if (weight.weight > 0) weights.Add(bones[weight.boneIndex].name, weight.weight);
            }
            result[vertex] = weights;
        }
        return result;
    }
}
