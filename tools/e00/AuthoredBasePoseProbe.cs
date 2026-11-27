using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class AuthoredBasePoseProbe
{
    const string Folder = "Assets/Fixtures/authored-base-pose/";
    const int Samples = 81;
    const float PositionTolerance = 2e-5f;
    const float DeformationTolerance = .001f;

    [Serializable] sealed class Report
    {
        public string unityVersion, sourceClip, adaptedClip;
        public float sourceSeconds, adaptedSeconds;
        public bool compatible;
        public Result[] meshes;
    }

    [Serializable] sealed class Result
    {
        public string name;
        public int vertices, triangles, weightedBones, missingVertices, samples;
        public float maxBaseError, maxWeightError, maxDeformationError, shapeChange, restMotion, worstTime;
        public bool compatible;
    }

    public static void Run()
    {
        var source = Load("original", "mixamo.com", out var clip);
        var output = Load("exported", "mixamo.com_Adapted_1", out var adapted);
        try {
            var sourceMeshes = source.GetComponentsInChildren<SkinnedMeshRenderer>();
            var targetMeshes = output.GetComponentsInChildren<SkinnedMeshRenderer>();
            if (sourceMeshes.Length != 2 || targetMeshes.Length != 2) throw new InvalidOperationException("Expected two skinned meshes.");
            var report = new Report {
                unityVersion = Application.unityVersion, sourceClip = clip.name, adaptedClip = adapted.name,
                sourceSeconds = clip.length, adaptedSeconds = adapted.length,
                meshes = sourceMeshes.Select(mesh => Compare(source, output, mesh, targetMeshes.Single(other => other.name == mesh.name), clip, adapted)).ToArray(),
            };
            report.compatible = Mathf.Abs(clip.length - adapted.length) < 1e-4f && report.meshes.All(mesh => mesh.compatible);
            File.WriteAllText("authored-base-pose.json", JsonUtility.ToJson(report, true));
            if (!report.compatible) throw new InvalidOperationException("Authored base pose verification failed. See authored-base-pose.json.");
        } finally {
            UnityEngine.Object.DestroyImmediate(source);
            UnityEngine.Object.DestroyImmediate(output);
        }
    }

    static GameObject Load(string directory, string clipName, out AnimationClip clip)
    {
        var path = Directory.GetFiles(Folder + directory, "*.fbx").Single().Replace('\\', '/');
        clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>().Single(item => item.name == clipName);
        return UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
    }

    static Result Compare(GameObject source, GameObject target, SkinnedMeshRenderer input, SkinnedMeshRenderer output,
        AnimationClip clip, AnimationClip adapted)
    {
        var a = input.sharedMesh;
        var b = output.sharedMesh;
        var result = new Result { name = input.name, vertices = b.vertexCount, triangles = b.triangles.Length / 3, weightedBones = output.bones.Length };
        var boneIndices = input.bones.Select((bone, i) => (bone, i)).ToDictionary(entry => BoneName(entry.bone), entry => entry.i);
        if (a.triangles.Length != b.triangles.Length || !boneIndices.Keys.ToHashSet().SetEquals(output.bones.Select(BoneName))) return result;
        var targetPalette = output.bones.Select(bone => boneIndices[BoneName(bone)]).ToArray();
        int jointIndex = Array.FindIndex(input.bones, bone => bone.name.EndsWith("LeftForeArm", StringComparison.Ordinal));
        var joint = input.bones[jointIndex];
        int parentIndex = Array.IndexOf(input.bones, joint.parent);
        var affected = input.bones.Select(bone => bone == joint || bone.IsChildOf(joint)).ToArray();

        var sourceWorld = input.transform.localToWorldMatrix;
        var targetWorld = output.transform.localToWorldMatrix;
        var bind = a.bindposes.Select(localToBone => sourceWorld * localToBone.inverse).ToArray();
        var bindLocal = bind[parentIndex].inverse * bind[jointIndex];
        // Unity's reflected X axis reverses a positive FBX rotation about Z.
        var correction = bindLocal.rotation * Quaternion.AngleAxis(-15, Vector3.forward) * Quaternion.Inverse(bindLocal.rotation);
        var restDelta = WorldDelta(bind[parentIndex], bindLocal, correction);
        var newBindInverse = bind.Select((world, i) => (affected[i] ? restDelta * world : world).inverse).ToArray();
        var restMatrices = bind.Select((world, i) => (affected[i] ? restDelta * world : world) * a.bindposes[i]).ToArray();
        var points = a.vertices;
        var weights = a.boneWeights;
        var targetPoints = b.vertices;
        var targetWeights = b.boneWeights;
        var basePoints = points.Select((point, i) => Blend(point, weights[i], restMatrices)).ToArray();
        var mapped = new int[targetPoints.Length];
        var cells = Enumerable.Range(0, basePoints.Length).ToLookup(index => Cell(basePoints[index]));
        var palette = Enumerable.Range(0, input.bones.Length).ToArray();
        for (int i = 0; i < targetPoints.Length; i++) {
            var world = targetWorld.MultiplyPoint3x4(targetPoints[i]);
            var cell = Cell(world);
            int best = -1;
            float bestWeight = float.PositiveInfinity, bestPosition = float.PositiveInfinity;
            var outgoing = Weights(targetWeights[i], targetPalette);
            for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
                foreach (int candidate in cells[cell + new Vector3Int(x, y, z)]) {
                    float distance = Vector3.Distance(world, basePoints[candidate]);
                    if (distance > PositionTolerance) continue;
                    float weightError = WeightError(Weights(weights[candidate], palette), outgoing);
                    if (weightError > bestWeight || weightError == bestWeight && distance >= bestPosition) continue;
                    best = candidate;
                    bestWeight = weightError;
                    bestPosition = distance;
                }
            }
            mapped[i] = best;
            if (best < 0) { result.missingVertices++; continue; }
            result.maxBaseError = Mathf.Max(result.maxBaseError, bestPosition);
            result.maxWeightError = Mathf.Max(result.maxWeightError, bestWeight);
            result.restMotion = Mathf.Max(result.restMotion, Vector3.Distance(basePoints[best], sourceWorld.MultiplyPoint3x4(points[best])));
        }
        if (result.missingVertices > 0) return result;

        var baked = new Mesh();
        try {
            Vector3[] start = null;
            for (int sample = 0; sample < Samples; sample++) {
                float time = clip.length * sample / (Samples - 1);
                clip.SampleAnimation(source, time);
                adapted.SampleAnimation(target, adapted.length * sample / (Samples - 1));
                var parentWorld = joint.parent.localToWorldMatrix;
                var animatedLocal = parentWorld.inverse * joint.localToWorldMatrix;
                var delta = WorldDelta(parentWorld, animatedLocal, correction);
                var matrices = input.bones.Select((bone, i) => (affected[i] ? delta * bone.localToWorldMatrix : bone.localToWorldMatrix) * newBindInverse[i]).ToArray();
                var expected = basePoints.Select((point, i) => Blend(point, weights[i], matrices)).ToArray();
                if (start == null) start = expected;
                output.BakeMesh(baked, false);
                var actual = baked.vertices;
                for (int i = 0; i < actual.Length; i++) {
                    int index = mapped[i];
                    float error = Vector3.Distance(expected[index], output.transform.TransformPoint(actual[i]));
                    if (error > result.maxDeformationError) { result.maxDeformationError = error; result.worstTime = time; }
                    result.shapeChange = Mathf.Max(result.shapeChange, Mathf.Abs(Vector3.Distance(expected[index], expected[0]) - Vector3.Distance(start[index], start[0])));
                }
                result.samples++;
            }
        } finally { UnityEngine.Object.DestroyImmediate(baked); }
        result.compatible = result.maxWeightError <= 1e-6f && result.maxDeformationError <= DeformationTolerance &&
            result.shapeChange > .01f && result.restMotion > .005f && result.samples == Samples;
        return result;
    }

    static Matrix4x4 WorldDelta(Matrix4x4 parent, Matrix4x4 local, Quaternion rotation)
    {
        var value = Matrix4x4.TRS(local.GetColumn(3), rotation * local.rotation, local.lossyScale);
        return parent * value * local.inverse * parent.inverse;
    }

    static Vector3 Blend(Vector3 p, BoneWeight w, Matrix4x4[] matrices) =>
        matrices[w.boneIndex0].MultiplyPoint3x4(p) * w.weight0 + matrices[w.boneIndex1].MultiplyPoint3x4(p) * w.weight1 +
        matrices[w.boneIndex2].MultiplyPoint3x4(p) * w.weight2 + matrices[w.boneIndex3].MultiplyPoint3x4(p) * w.weight3;

    static Vector3Int Cell(Vector3 v) => Vector3Int.FloorToInt(v / PositionTolerance);
    static string BoneName(Transform bone) => bone.name.Replace(":", "");

    static Dictionary<int, float> Weights(BoneWeight w, int[] map)
    {
        var result = new Dictionary<int, float>();
        if (w.weight0 > 0) result[map[w.boneIndex0]] = w.weight0;
        if (w.weight1 > 0) result[map[w.boneIndex1]] = w.weight1;
        if (w.weight2 > 0) result[map[w.boneIndex2]] = w.weight2;
        if (w.weight3 > 0) result[map[w.boneIndex3]] = w.weight3;
        return result;
    }

    static float WeightError(Dictionary<int, float> a, Dictionary<int, float> b) =>
        a.Count != b.Count || a.Keys.Any(index => !b.ContainsKey(index)) ? 1 : a.Keys.Select(index => Mathf.Abs(a[index] - b[index])).DefaultIfEmpty().Max();
}
