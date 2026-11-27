using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class E09Probe
{
    const float Tolerance = 1e-5f;
    static readonly string[] Cases = { "undone", "moved", "renamed", "deleted" };
    static readonly string[] MeshNames = { "Body", "Clothing" };

    [Serializable] sealed class Report { public string unityVersion; public Check[] cases; }
    [Serializable] sealed class Check
    {
        public string name, clip;
        public bool compatible, shared;
        public float jointDisplacement, descendantDisplacement;
        public MeshCheck[] meshes;
    }
    [Serializable] sealed class MeshCheck
    {
        public string name;
        public float baseError, uvError, restError, weightError, poseChange, clipDifference;
        public int samples;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject Root;
        public readonly AnimationClip Clip;
        public readonly SkinnedMeshRenderer[] Meshes;
        public Model(string name)
        {
            var path = Directory.GetFiles($"Assets/Fixtures/{name}", "*.fbx", SearchOption.AllDirectories).Single().Replace('\\', '/');
            Root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            Clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                .SingleOrDefault(clip => !clip.name.StartsWith("__preview__", StringComparison.Ordinal));
            var renderers = Root.GetComponentsInChildren<SkinnedMeshRenderer>();
            Meshes = MeshNames.Select(item => renderers.Single(mesh => mesh.name == item)).ToArray();
        }
        public Transform Bone(string name) => Root.GetComponentsInChildren<Transform>().SingleOrDefault(node => node.name == name);
        public void Dispose() => UnityEngine.Object.DestroyImmediate(Root);
    }

    public static void Run()
    {
        var report = new Report { unityVersion = Application.unityVersion, cases = Cases.Select(Compare).ToArray() };
        File.WriteAllText("e09-report.json", JsonUtility.ToJson(report, true));
        if (!report.cases.All(item => item.compatible)) throw new InvalidOperationException("E09 verification failed. See e09-report.json.");
    }

    static Check Compare(string name)
    {
        using (var source = new Model("original"))
        using (var target = new Model(name)) {
            bool deleted = name == "deleted", moved = name == "moved", renamed = name == "renamed";
            string spineName = renamed ? "MidSpine" : "Spine";
            var pelvis = target.Bone("Pelvis");
            var spine = target.Bone(spineName);
            var chest = target.Bone("Chest");
            var probe = target.Bone("ProbeChild");
            var result = new Check {
                name = name, clip = target.Clip?.name, shared = pelvis && chest &&
                    (deleted ? spine == null && probe && probe.parent == pelvis : spine && spine.parent == pelvis) &&
                    chest.parent == (deleted ? pelvis : spine) && target.Meshes.All(mesh => mesh.rootBone == pelvis &&
                        mesh.bones.Contains(pelvis) && mesh.bones.Contains(chest) && (deleted || mesh.bones.Contains(spine))),
                jointDisplacement = spine ? Vector3.Distance(source.Bone("Spine").position, spine.position) : 0,
                descendantDisplacement = chest ? Vector3.Distance(source.Bone("Chest").position, chest.position) : float.PositiveInfinity,
            };
            result.meshes = MeshNames.Select((_, i) => CompareMesh(source, target, i, spineName, deleted)).ToArray();
            result.compatible = result.shared && Mathf.Abs(result.jointDisplacement - (moved ? .12f : 0f)) <= Tolerance &&
                result.descendantDisplacement <= Tolerance && (deleted ? target.Clip == null :
                    result.clip == (moved ? "SharedTorsoBend_Adapted_1" : "SharedTorsoBend") && Mathf.Abs(target.Clip.length - 1) <= Tolerance) &&
                result.meshes.All(mesh => mesh.baseError <= Tolerance && mesh.uvError <= Tolerance && mesh.restError <= Tolerance &&
                    mesh.weightError <= 1e-6f && (deleted || (mesh.samples == 21 && mesh.poseChange > .01f && (moved || mesh.clipDifference <= Tolerance))));
            return result;
        }
    }

    static MeshCheck CompareMesh(Model source, Model target, int index, string spineName, bool deleted)
    {
        var a = source.Meshes[index];
        var b = target.Meshes[index];
        var result = new MeshCheck { name = a.name };
        var before = Points(a, a.sharedMesh);
        var after = Points(b, b.sharedMesh);
        if (after.Length != before.Length || a.sharedMesh.triangles.Length != b.sharedMesh.triangles.Length)
            throw new InvalidOperationException($"Mesh size mismatch on {a.name}.");
        var matches = new int[before.Length];
        var used = new bool[after.Length];
        var uvA = a.sharedMesh.uv;
        var uvB = b.sharedMesh.uv;
        var weightsA = a.sharedMesh.boneWeights;
        var weightsB = b.sharedMesh.boneWeights;
        var bakedA = new Mesh();
        var bakedB = new Mesh();
        try {
            for (int i = 0; i < before.Length; i++) {
                int j = 0;
                for (; j < after.Length; j++)
                    if (!used[j] && Vector3.Distance(before[i], after[j]) < Tolerance && Vector2.Distance(uvA[i], uvB[j]) < Tolerance) break;
                if (j == after.Length) throw new InvalidOperationException($"No base vertex and UV match on {a.name}.");
                matches[i] = j;
                used[j] = true;
                result.baseError = Mathf.Max(result.baseError, Vector3.Distance(before[i], after[j]));
                result.uvError = Mathf.Max(result.uvError, Vector2.Distance(uvA[i], uvB[j]));
                var left = Weights(a, weightsA[i], deleted ? "Pelvis" : spineName);
                var right = Weights(b, weightsB[j], "Spine");
                foreach (string bone in left.Keys.Union(right.Keys)) {
                    left.TryGetValue(bone, out float x);
                    right.TryGetValue(bone, out float y);
                    result.weightError = Mathf.Max(result.weightError, Mathf.Abs(x - y));
                }
            }
            b.BakeMesh(bakedB);
            var rest = Points(b, bakedB);
            for (int i = 0; i < after.Length; i++) result.restError = Mathf.Max(result.restError, Vector3.Distance(after[i], rest[i]));
            if (target.Clip) for (int sample = 0; sample <= 20; sample++) {
                source.Clip.SampleAnimation(source.Root, source.Clip.length * sample / 20f);
                target.Clip.SampleAnimation(target.Root, target.Clip.length * sample / 20f);
                a.BakeMesh(bakedA);
                b.BakeMesh(bakedB);
                var x = Points(a, bakedA);
                var y = Points(b, bakedB);
                for (int i = 0; i < x.Length; i++) {
                    int j = matches[i];
                    result.clipDifference = Mathf.Max(result.clipDifference, Vector3.Distance(x[i], y[j]));
                    result.poseChange = Mathf.Max(result.poseChange, Mathf.Abs(Vector3.Distance(y[matches[0]], y[j]) -
                        Vector3.Distance(rest[matches[0]], rest[j])));
                }
                result.samples++;
            }
        } finally {
            UnityEngine.Object.DestroyImmediate(bakedA);
            UnityEngine.Object.DestroyImmediate(bakedB);
        }
        return result;
    }

    static Vector3[] Points(SkinnedMeshRenderer mesh, Mesh data) => data.vertices.Select(mesh.transform.TransformPoint).ToArray();

    static Dictionary<string, float> Weights(SkinnedMeshRenderer mesh, BoneWeight weight, string spine)
    {
        var row = new Dictionary<string, float>();
        void Add(int slot, float value) {
            if (value <= 0) return;
            string name = mesh.bones[slot].name;
            if (name == "Spine") name = spine;
            row.TryGetValue(name, out float prior);
            row[name] = prior + value;
        }
        Add(weight.boneIndex0, weight.weight0);
        Add(weight.boneIndex1, weight.weight1);
        Add(weight.boneIndex2, weight.weight2);
        Add(weight.boneIndex3, weight.weight3);
        return row;
    }
}
