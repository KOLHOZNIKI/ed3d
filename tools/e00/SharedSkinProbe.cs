using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class SharedSkinProbe
{
    static readonly string[] BoneNames = { "Pelvis", "Spine", "Chest" };
    static readonly string[] MeshNames = { "Body", "Clothing" };
    const float PositionTolerance = 1e-5f;

    [Serializable] sealed class Report
    {
        public string unityVersion, clip;
        public bool compatible, originalSharedSkeleton, exportedSharedSkeleton;
        public float originalClipSeconds, exportedClipSeconds;
        public MeshReport[] meshes;
    }

    [Serializable] sealed class MeshReport
    {
        public string name;
        public bool compatible;
        public int vertices, triangles, poseSamples;
        public float maxBaseDelta, maxBindMatrixDelta, maxWeightDelta, restError, maxPoseError, sourceShapeChange;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject root;
        public readonly SkinnedMeshRenderer[] meshes;
        public readonly AnimationClip clip;
        public readonly bool sharedSkeleton;

        public Model(string directory)
        {
            var path = Directory.GetFiles(directory, "*.fbx").Single().Replace('\\', '/');
            root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            try {
                var renderers = root.GetComponentsInChildren<SkinnedMeshRenderer>();
                if (renderers.Length != MeshNames.Length) throw new InvalidOperationException($"Expected two skinned meshes in {path}.");
                meshes = MeshNames.Select(name => renderers.Single(renderer => renderer.name == name)).ToArray();
                clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                    .Single(take => !take.name.StartsWith("__preview__", StringComparison.Ordinal));
                var transforms = root.GetComponentsInChildren<Transform>();
                var bones = BoneNames.Select(name => transforms.SingleOrDefault(bone => bone.name == name)).ToArray();
                sharedSkeleton = bones.All(bone => bone != null) && bones[1].parent == bones[0] && bones[2].parent == bones[1] &&
                    meshes.All(mesh => mesh.bones.Length == bones.Length && bones.All(mesh.bones.Contains)) &&
                    meshes[0].rootBone == bones[0] && meshes[1].rootBone == bones[0];
            } catch {
                Dispose();
                throw;
            }
        }

        public void Dispose() => UnityEngine.Object.DestroyImmediate(root);
    }

    public static void Run()
    {
        using (var original = new Model("Assets/Fixtures/shared-skin/original"))
        using (var exported = new Model("Assets/Fixtures/shared-skin/exported")) {
            var report = new Report {
                unityVersion = Application.unityVersion, clip = original.clip.name,
                originalSharedSkeleton = original.sharedSkeleton, exportedSharedSkeleton = exported.sharedSkeleton,
                originalClipSeconds = original.clip.length, exportedClipSeconds = exported.clip.length,
            };
            report.meshes = Enumerable.Range(0, MeshNames.Length).Select(i => CompareMesh(original, exported, i)).ToArray();
            report.compatible = report.originalSharedSkeleton && report.exportedSharedSkeleton && report.clip == "SharedTorsoBend" &&
                original.clip.name == exported.clip.name && Mathf.Abs(report.originalClipSeconds - 1f) <= 1e-5f &&
                Mathf.Abs(report.originalClipSeconds - report.exportedClipSeconds) <= 1e-5f && report.meshes.All(mesh => mesh.compatible);
            File.WriteAllText("shared-skin-report.json", JsonUtility.ToJson(report, true));
            if (!report.compatible) throw new InvalidOperationException("F10 shared skin verification failed. See shared-skin-report.json.");
            Debug.Log("Verified F10 body and clothing on the shared skeleton. See shared-skin-report.json.");
        }
    }

    static MeshReport CompareMesh(Model original, Model exported, int index)
    {
        var source = original.meshes[index];
        var target = exported.meshes[index];
        var a = source.sharedMesh;
        var b = target.sharedMesh;
        var result = new MeshReport { name = source.name, vertices = a.vertexCount, triangles = a.triangles.Length / 3 };
        if (a.vertexCount != b.vertexCount || a.triangles.Length != b.triangles.Length ||
            a.bindposes.Length != BoneNames.Length || b.bindposes.Length != BoneNames.Length) return result;

        var before = WorldPoints(source, a);
        var after = WorldPoints(target, b);
        var matches = new int[before.Length];
        var used = new bool[after.Length];
        for (int i = 0; i < before.Length; i++) {
            int j = 0;
            for (; j < after.Length; j++)
                if (!used[j] && Vector3.Distance(before[i], after[j]) <= PositionTolerance) break;
            if (j == after.Length) return result;
            matches[i] = j;
            used[j] = true;
        }
        result.maxBaseDelta = MaxPointDelta(before, after, matches);
        var weightsA = a.boneWeights;
        var weightsB = b.boneWeights;
        if (weightsA.Length != before.Length || weightsB.Length != after.Length) return result;
        for (int i = 0; i < weightsA.Length; i++) {
            var incoming = WeightsByBone(source, weightsA[i]);
            var outgoing = WeightsByBone(target, weightsB[matches[i]]);
            if (incoming.Count != outgoing.Count || incoming.Keys.Any(name => !outgoing.ContainsKey(name))) return result;
            foreach (var name in incoming.Keys)
                result.maxWeightDelta = Mathf.Max(result.maxWeightDelta, Mathf.Abs(incoming[name] - outgoing[name]));
        }
        var bindA = a.bindposes;
        var bindB = b.bindposes;
        for (int i = 0; i < source.bones.Length; i++) {
            int j = Array.FindIndex(target.bones, bone => bone.name == source.bones[i].name);
            if (j < 0) return result;
            for (int k = 0; k < 16; k++)
                result.maxBindMatrixDelta = Mathf.Max(result.maxBindMatrixDelta, Mathf.Abs(bindA[i][k] - bindB[j][k]));
        }

        var bakedA = new Mesh();
        var bakedB = new Mesh();
        try {
            Vector3[] rest = null;
            for (int sample = 0; sample <= 20; sample++) {
                original.clip.SampleAnimation(original.root, original.clip.length * sample / 20f);
                exported.clip.SampleAnimation(exported.root, exported.clip.length * sample / 20f);
                source.BakeMesh(bakedA, false);
                target.BakeMesh(bakedB, false);
                var pose = WorldPoints(source, bakedA);
                var outputPose = WorldPoints(target, bakedB);
                float error = MaxPointDelta(pose, outputPose, matches);
                if (sample == 0) {
                    rest = pose;
                    result.restError = error;
                }
                result.maxPoseError = Mathf.Max(result.maxPoseError, error);
                for (int i = 0; i < pose.Length; i++)
                    result.sourceShapeChange = Mathf.Max(result.sourceShapeChange, Mathf.Abs(
                        Vector3.Distance(pose[0], pose[i]) - Vector3.Distance(rest[0], rest[i])));
                result.poseSamples++;
            }
        } finally {
            UnityEngine.Object.DestroyImmediate(bakedA);
            UnityEngine.Object.DestroyImmediate(bakedB);
        }
        result.compatible = result.maxPoseError <= PositionTolerance && result.maxWeightDelta <= 1e-6f &&
            result.maxBindMatrixDelta <= 1e-6f && result.sourceShapeChange > 0.01f;
        return result;
    }

    static Dictionary<string, float> WeightsByBone(SkinnedMeshRenderer mesh, BoneWeight weights)
    {
        var result = new Dictionary<string, float>();
        var bones = mesh.bones;
        if (weights.weight0 > 0) result.Add(bones[weights.boneIndex0].name, weights.weight0);
        if (weights.weight1 > 0) result.Add(bones[weights.boneIndex1].name, weights.weight1);
        if (weights.weight2 > 0) result.Add(bones[weights.boneIndex2].name, weights.weight2);
        if (weights.weight3 > 0) result.Add(bones[weights.boneIndex3].name, weights.weight3);
        return result;
    }

    static Vector3[] WorldPoints(SkinnedMeshRenderer mesh, Mesh data) => data.vertices.Select(mesh.transform.TransformPoint).ToArray();

    static float MaxPointDelta(Vector3[] before, Vector3[] after, int[] matches) => Enumerable.Range(0, matches.Length)
        .Max(i => Vector3.Distance(before[i], after[matches[i]]));
}
