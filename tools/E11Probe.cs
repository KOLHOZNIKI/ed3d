using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class E11Probe
{
    const float Tolerance = 1e-5f;
    static readonly string[] Motions = { "idle", "walk", "run", "jump", "squat", "sit", "wave", "punch", "reach", "twist" };

    [Serializable] sealed class Report
    {
        public string unityVersion;
        public bool compatible, samePoseOnPreviewExport, sameBind, intermediateJoints;
        public int renderVertices, changedWeightVertices;
        public float maxBaseDelta, maxUvDelta, maxExpectedWeightError, squatOffset, squatDrop, walkTravel, runTravel, originalTravel;
        public MotionCheck[] animations;
    }

    [Serializable] sealed class MotionCheck
    {
        public string name;
        public int samples;
        public float duration, deformation, predictionError;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject Root;
        public readonly SkinnedMeshRenderer Skin;
        public readonly Dictionary<string, AnimationClip> Clips;
        public readonly Dictionary<string, Transform> Nodes;
        public Mesh Mesh => Skin.sharedMesh;
        public Model(string name)
        {
            var path = Directory.GetFiles($"Assets/Fixtures/{name}", "*.fbx", SearchOption.AllDirectories).Single().Replace('\\', '/');
            Root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            Skin = Root.GetComponentsInChildren<SkinnedMeshRenderer>().Single();
            Clips = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>().Where(clip => !clip.name.StartsWith("__preview__", StringComparison.Ordinal))
                .ToDictionary(clip => clip.name);
            Nodes = Root.GetComponentsInChildren<Transform>().Where(node => node != Root.transform).ToDictionary(node => node.name);
        }
        public Vector3[] Points(Mesh mesh) => mesh.vertices.Select(Skin.transform.TransformPoint).ToArray();
        public void Dispose() => UnityEngine.Object.DestroyImmediate(Root);
    }

    public static void Run()
    {
        using (var original = new Model("original"))
        using (var preview = new Model("preview"))
        using (var output = new Model("published")) {
            var report = Verify(original, preview, output);
            File.WriteAllText("e11-report.json", JsonUtility.ToJson(report, true));
            if (!report.compatible) throw new InvalidOperationException("E11 verification failed. See e11-report.json.");
        }
    }

    static Report Verify(Model original, Model preview, Model output)
    {
        var report = new Report { unityVersion = Application.unityVersion, renderVertices = output.Mesh.vertexCount };
        report.sameBind = SameBind(original, output) && SameBind(original, preview);
        report.intermediateJoints = new[] { "Left", "Right" }.All(side => output.Nodes[$"{side}Forearm"].parent ==
            output.Nodes[$"{side}ArmTwist"] && output.Nodes[$"{side}ArmTwist"].parent == output.Nodes[$"{side}UpperArm"]);
        var originalPoints = original.Points(original.Mesh);
        var targetPoints = output.Points(output.Mesh);
        var previewPoints = preview.Points(preview.Mesh);
        var match = Correspondence(original, output);
        var matchPreview = Correspondence(original, preview);
        var weightsOriginal = ReadWeights(original);
        var weightsOutput = ReadWeights(output);
        var weightsPreview = ReadWeights(preview);
        report.samePoseOnPreviewExport = preview.Clips.Count == 1 && preview.Clips.ContainsKey("SourceStep");
        var originalHips = original.Nodes["Hips"].position;
        for (int i = 0; i < match.Length; i++) {
            int j = match[i];
            report.maxBaseDelta = Mathf.Max(report.maxBaseDelta, Vector3.Distance(originalPoints[i], targetPoints[j]));
            report.maxUvDelta = Mathf.Max(report.maxUvDelta, Vector2.Distance(original.Mesh.uv[i], output.Mesh.uv[j]));
            var before = weightsOriginal[i];
            var after = weightsOutput[j];
            report.samePoseOnPreviewExport &= Vector3.Distance(originalPoints[i], previewPoints[matchPreview[i]]) <= Tolerance &&
                SameWeights(before, weightsPreview[matchPreview[i]]);
            if (!SameWeights(before, after)) {
                report.changedWeightVertices++;
                report.maxExpectedWeightError = Mathf.Max(report.maxExpectedWeightError, Mathf.Abs(after["Hips"] - .7f),
                    Mathf.Abs(after["Spine"] - .3f), Mathf.Abs(after.Values.Sum() - 1));
            }
        }
        var expected = Motions.Select(name => $"Diagnostic_{name}").Append("SourceStep").ToArray();
        if (!expected.OrderBy(name => name).SequenceEqual(output.Clips.Keys.OrderBy(name => name))) return report;
        using (var baked = new MeshOwner()) {
            report.animations = expected.Select(name => Sample(output, output.Clips[name], baked.Mesh, weightsOutput)).ToArray();
        }
        var hip = output.Nodes["Hips"];
        var squat = output.Clips["Diagnostic_squat"];
        squat.SampleAnimation(output.Root, 0);
        Vector3 raised = hip.position;
        squat.SampleAnimation(output.Root, squat.length / 2);
        report.squatOffset = raised.y - originalHips.y;
        report.squatDrop = raised.y - hip.position.y;
        report.walkTravel = Travel(output, "Diagnostic_walk");
        report.runTravel = Travel(output, "Diagnostic_run");
        report.originalTravel = Travel(output, "SourceStep");
        report.compatible = report.sameBind && report.intermediateJoints && report.samePoseOnPreviewExport &&
            report.changedWeightVertices >= 3 && report.maxExpectedWeightError <= Tolerance && report.maxBaseDelta <= Tolerance &&
            report.maxUvDelta <= Tolerance && report.animations.All(clip => clip.samples == 21 && clip.deformation > .005f && clip.predictionError <= Tolerance) &&
            Mathf.Abs(report.squatOffset - .035f) < .001f && report.squatDrop > .39f && report.walkTravel > 1f && report.runTravel < .001f &&
            Mathf.Abs(report.originalTravel - .44f) < .001f;
        return report;
    }

    static bool SameBind(Model a, Model b)
    {
        var target = b.Skin.bones.Select((bone, index) => new { bone.name, index }).ToDictionary(item => item.name, item => item.index);
        if (a.Skin.bones.Length != b.Skin.bones.Length) return false;
        for (int i = 0; i < a.Skin.bones.Length; i++) {
            var bone = a.Skin.bones[i];
            if (!target.TryGetValue(bone.name, out int other) || Vector3.Distance(bone.position, b.Skin.bones[other].position) > Tolerance) return false;
            for (int k = 0; k < 16; k++) if (Mathf.Abs(a.Mesh.bindposes[i][k] - b.Mesh.bindposes[other][k]) > Tolerance) return false;
        }
        return true;
    }

    static int[] Correspondence(Model source, Model output)
    {
        var a = source.Points(source.Mesh);
        var b = output.Points(output.Mesh);
        var uvA = source.Mesh.uv;
        var uvB = output.Mesh.uv;
        var used = new bool[b.Length];
        if (a.Length != b.Length || source.Mesh.triangles.Length != output.Mesh.triangles.Length) throw new InvalidOperationException("The mesh changed topology.");
        return Enumerable.Range(0, a.Length).Select(i => {
            for (int j = 0; j < b.Length; j++) if (!used[j] && Vector3.Distance(a[i], b[j]) <= Tolerance && Vector2.Distance(uvA[i], uvB[j]) <= Tolerance) {
                used[j] = true;
                return j;
            }
            throw new InvalidOperationException("A base vertex or UV changed.");
        }).ToArray();
    }

    static MotionCheck Sample(Model model, AnimationClip clip, Mesh baked, Dictionary<string, float>[] weights)
    {
        var check = new MotionCheck { name = clip.name, duration = clip.length };
        var local = model.Mesh.vertices;
        var bind = model.Mesh.bindposes;
        var names = model.Skin.bones.Select(bone => bone.name).ToArray();
        Vector3[] start = null;
        for (int i = 0; i <= 20; i++) {
            clip.SampleAnimation(model.Root, clip.length * i / 20f);
            model.Skin.BakeMesh(baked, false);
            var points = model.Points(baked);
            if (i == 0) start = points;
            var matrices = model.Skin.bones.Select((bone, j) => bone.localToWorldMatrix * bind[j]).ToArray();
            for (int j = 0; j < points.Length; j++) {
                var predicted = Vector3.zero;
                for (int k = 0; k < names.Length; k++) if (weights[j].TryGetValue(names[k], out float weight))
                    predicted += matrices[k].MultiplyPoint3x4(local[j]) * weight;
                check.predictionError = Mathf.Max(check.predictionError, Vector3.Distance(predicted, points[j]));
                check.deformation = Mathf.Max(check.deformation, Vector3.Distance(start[j], points[j]));
            }
            check.samples++;
        }
        return check;
    }

    static float Travel(Model model, string name)
    {
        var clip = model.Clips[name];
        var hip = model.Nodes["Hips"];
        clip.SampleAnimation(model.Root, 0);
        Vector3 start = hip.position;
        clip.SampleAnimation(model.Root, clip.length);
        Vector3 end = hip.position;
        return Vector2.Distance(new Vector2(start.x, start.z), new Vector2(end.x, end.z));
    }

    static bool SameWeights(Dictionary<string, float> a, Dictionary<string, float> b) => a.Count == b.Count &&
        a.All(item => b.TryGetValue(item.Key, out float value) && Mathf.Abs(item.Value - value) <= 1e-6f);

    static Dictionary<string, float>[] ReadWeights(Model model)
    {
        var counts = model.Mesh.GetBonesPerVertex();
        var flat = model.Mesh.GetAllBoneWeights();
        var rows = new Dictionary<string, float>[counts.Length];
        int pointer = 0;
        for (int vertex = 0; vertex < counts.Length; vertex++) {
            var row = rows[vertex] = new Dictionary<string, float>();
            for (int i = 0; i < counts[vertex]; i++) {
                var weight = flat[pointer++];
                if (weight.weight > 0) row.Add(model.Skin.bones[weight.boneIndex].name, weight.weight);
            }
        }
        return rows;
    }

    sealed class MeshOwner : IDisposable
    {
        public readonly Mesh Mesh = new Mesh();
        public void Dispose() => UnityEngine.Object.DestroyImmediate(Mesh);
    }
}
