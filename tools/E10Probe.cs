using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public sealed class E10ImportSetup : AssetPostprocessor
{
    void OnPreprocessModel()
    {
        if (assetImporter is ModelImporter importer && assetPath.StartsWith("Assets/Fixtures/", StringComparison.Ordinal)) {
            importer.skinWeights = ModelImporterSkinWeights.Custom;
            importer.maxBonesPerVertex = 8;
            importer.minBoneWeight = 0;
        }
    }
}

public static class E10Probe
{
    const float Tolerance = 1e-5f;

    [Serializable] sealed class Report { public string unityVersion; public Result[] cases; }
    [Serializable] sealed class Result
    {
        public string name, clip;
        public bool compatible;
        public int renderVertices, changedRenderCopies, maxInfluences, samples;
        public float weightError, lockedWeightError, uvError, baseError, seamError, deformationChange, unaffectedError, predictionError;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject Root;
        public readonly SkinnedMeshRenderer Skin;
        public readonly AnimationClip Clip;
        public Mesh Mesh => Skin.sharedMesh;
        public Model(string directory)
        {
            string path = Directory.GetFiles(directory, "*.fbx", SearchOption.AllDirectories).Single().Replace('\\', '/');
            Root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            Skin = Root.GetComponentsInChildren<SkinnedMeshRenderer>().Single();
            Skin.quality = SkinQuality.Auto;
            Clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                .Single(clip => !clip.name.StartsWith("__preview__", StringComparison.Ordinal));
        }
        public void Dispose() => UnityEngine.Object.DestroyImmediate(Root);
        public Vector3[] Points(Mesh mesh) => mesh.vertices.Select(Skin.transform.TransformPoint).ToArray();
    }

    public static void Run()
    {
        var quality = QualitySettings.skinWeights;
        QualitySettings.skinWeights = SkinWeights.Unlimited;
        try {
            var report = new Report { unityVersion = Application.unityVersion, cases = new[] {
                Compare("fingers", "edited"), Compare("fingers", "undone"), Compare("wide", "edited"), Compare("wide", "undone") } };
            File.WriteAllText("e10-report.json", JsonUtility.ToJson(report, true));
            if (report.cases.Any(item => !item.compatible)) throw new InvalidOperationException("E10 verification failed. See e10-report.json.");
        } finally { QualitySettings.skinWeights = quality; }
    }

    static Result Compare(string fixture, string scenario)
    {
        using (var source = new Model($"Assets/Fixtures/{fixture}/original"))
        using (var output = new Model($"Assets/Fixtures/{fixture}/{scenario}")) {
            bool wide = fixture == "wide", edited = scenario == "edited";
            var before = source.Points(source.Mesh);
            var after = output.Points(output.Mesh);
            var uvA = source.Mesh.uv;
            var uvB = output.Mesh.uv;
            if (before.Length != after.Length || uvA.Length != uvB.Length || source.Mesh.triangles.Length != output.Mesh.triangles.Length)
                throw new InvalidOperationException($"Topology or attribute count mismatch for {fixture}.");
            var result = new Result { name = fixture + "/" + scenario, clip = output.Clip.name, renderVertices = before.Length };
            var sourceWeights = ReadWeights(source);
            var outputWeights = ReadWeights(output);
            var names = source.Skin.bones.Select(bone => bone.name).ToArray();
            var matches = new int[before.Length];
            var used = new bool[after.Length];
            var changed = new List<int>();
            var expected = new Dictionary<string, float>[before.Length];
            for (int i = 0; i < before.Length; i++) {
                int j = 0;
                for (; j < after.Length; j++)
                    if (!used[j] && Vector3.Distance(before[i], after[j]) <= Tolerance &&
                        (uvA.Length == 0 || Vector2.Distance(uvA[i], uvB[j]) <= Tolerance)) break;
                if (j == after.Length) throw new InvalidOperationException($"Missing position and UV match for {fixture}.");
                matches[i] = j;
                used[j] = true;
                result.baseError = Mathf.Max(result.baseError, Vector3.Distance(before[i], after[j]));
                if (uvA.Length > 0) result.uvError = Mathf.Max(result.uvError, Vector2.Distance(uvA[i], uvB[j]));
                result.maxInfluences = Mathf.Max(result.maxInfluences, outputWeights[j].Count);
                var row = expected[i] = new Dictionary<string, float>(sourceWeights[i]);
                bool target = wide ? Mathf.Abs(before[i].y - .75f) <= Tolerance :
                    Mathf.Abs(before[i].y - .5f) <= Tolerance && Mathf.Abs(Mathf.Abs(before[i].x) - .02f) <= Tolerance && row.ContainsKey("LeftFinger");
                if (edited && target) {
                    changed.Add(i);
                    if (wide) {
                        row.Remove("Joint5");
                        foreach (var id in row.Keys.Where(id => id != "Joint1").ToArray()) row[id] *= 22f / 19f;
                        result.lockedWeightError = Mathf.Max(result.lockedWeightError, Mathf.Abs(row["Joint1"] - outputWeights[j]["Joint1"]));
                    } else { row["Palm"] = .625f; row["LeftFinger"] = .375f; }
                }
                foreach (var name in row.Keys.Union(outputWeights[j].Keys)) {
                    row.TryGetValue(name, out float lhs);
                    outputWeights[j].TryGetValue(name, out float rhs);
                    result.weightError = Mathf.Max(result.weightError, Mathf.Abs(lhs - rhs));
                }
                result.weightError = Mathf.Max(result.weightError, Mathf.Abs(outputWeights[j].Values.Sum() - 1));
            }
            result.changedRenderCopies = changed.Count;
            var local = source.Mesh.vertices;
            var binds = source.Mesh.bindposes;
            var bakedA = new Mesh();
            var bakedB = new Mesh();
            try {
                for (int frame = 0; frame <= 20; frame++) {
                    source.Clip.SampleAnimation(source.Root, source.Clip.length * frame / 20f);
                    output.Clip.SampleAnimation(output.Root, output.Clip.length * frame / 20f);
                    source.Skin.BakeMesh(bakedA, false);
                    output.Skin.BakeMesh(bakedB, false);
                    var a = source.Points(bakedA);
                    var b = output.Points(bakedB);
                    var joints = source.Skin.bones.Select((bone, i) => bone.localToWorldMatrix * binds[i]).ToArray();
                    for (int i = 0; i < a.Length; i++) {
                        var predicted = Vector3.zero;
                        for (int j = 0; j < names.Length; j++) if (expected[i].TryGetValue(names[j], out float weight))
                            predicted += joints[j].MultiplyPoint3x4(local[i]) * weight;
                        var vertex = b[matches[i]];
                        result.predictionError = Mathf.Max(result.predictionError, Vector3.Distance(predicted, vertex));
                        if (changed.Contains(i)) result.deformationChange = Mathf.Max(result.deformationChange, Vector3.Distance(a[i], vertex));
                        else result.unaffectedError = Mathf.Max(result.unaffectedError, Vector3.Distance(a[i], vertex));
                    }
                    if (!wide && edited) foreach (int i in changed)
                        result.seamError = Mathf.Max(result.seamError, Vector3.Distance(b[matches[changed[0]]], b[matches[i]]));
                    result.samples++;
                }
            } finally {
                UnityEngine.Object.DestroyImmediate(bakedA);
                UnityEngine.Object.DestroyImmediate(bakedB);
            }
            // Arbitrary fractions in the converted rows are compared at Unity import precision.
            float weightTolerance = wide && edited ? 1e-5f : 1e-6f;
            float predictionTolerance = wide && edited ? 2e-5f : Tolerance;
            result.compatible = source.Clip.name == output.Clip.name && Mathf.Abs(source.Clip.length - output.Clip.length) <= Tolerance &&
                result.baseError <= Tolerance && result.uvError <= Tolerance && result.seamError <= Tolerance &&
                result.weightError <= weightTolerance && result.lockedWeightError <= weightTolerance &&
                result.unaffectedError <= Tolerance && result.predictionError <= predictionTolerance &&
                (edited ? changed.Count >= (wide ? 2 : 3) && result.deformationChange > .005f && result.maxInfluences <= 4 :
                    changed.Count == 0 && (!wide || result.maxInfluences == 5));
            return result;
        }
    }

    static Dictionary<string, float>[] ReadWeights(Model model)
    {
        var counts = model.Mesh.GetBonesPerVertex();
        var weights = model.Mesh.GetAllBoneWeights();
        var result = new Dictionary<string, float>[counts.Length];
        int i = 0;
        for (int vertex = 0; vertex < counts.Length; vertex++) {
            var row = result[vertex] = new Dictionary<string, float>();
            for (int slot = 0; slot < counts[vertex]; slot++) {
                var weight = weights[i++];
                if (weight.weight > 0) row.Add(model.Skin.bones[weight.boneIndex].name, weight.weight);
            }
        }
        return result;
    }
}
