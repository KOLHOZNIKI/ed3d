using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class E05Probe
{
    const float Tolerance = 2e-5f;

    [Serializable] sealed class Report
    {
        public string unityVersion;
        public int staticTriangles, staticOpenEdges, fanTriangles, fanOpenEdges, poseSamples;
        public float baseWeight, neckWeight, maxBasePoseError, maxCenterPoseError, centerMotion;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject root;
        public readonly AnimationClip clip;
        public readonly SkinnedMeshRenderer skin;
        public Model(string name)
        {
            var path = Directory.GetFiles("Assets/Fixtures/" + name, "*.fbx").Single().Replace('\\', '/');
            root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            skin = root.GetComponentInChildren<SkinnedMeshRenderer>();
            clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                .SingleOrDefault(take => !take.name.StartsWith("__preview__", StringComparison.Ordinal));
            var material = root.GetComponentInChildren<Renderer>().sharedMaterial;
            Check(material.GetTexture("_MainTex") != null, "Unity could not resolve the Base Color map.");
        }
        public Mesh Mesh => skin == null ? root.GetComponentInChildren<MeshFilter>().sharedMesh : skin.sharedMesh;
        public void Dispose() => UnityEngine.Object.DestroyImmediate(root);
    }

    public static void Run()
    {
        var result = new Report { unityVersion = Application.unityVersion };
        using (var source = new Model("bottle"))
        using (var target = new Model("bottle-repaired")) {
            var before = OpenEdges(source.Mesh);
            var after = OpenEdges(target.Mesh);
            result.staticTriangles = target.Mesh.triangles.Length / 3;
            result.staticOpenEdges = after.Count;
            Check(before.Count == 18 && result.staticTriangles == 106 && result.staticOpenEdges == 12 &&
                after.All(edge => before.Contains(edge) && Mathf.Abs(edge.Item1.y - 1.5f) < Tolerance &&
                    Mathf.Abs(edge.Item2.y - 1.5f) < Tolerance), "Auto Fill changed the mouth or left a side defect open.");
        }
        using (var before = new Model("skinned-bottle"))
        using (var after = new Model("skinned-bottle-repaired")) {
            result.fanTriangles = after.Mesh.triangles.Length / 3;
            result.fanOpenEdges = OpenEdges(after.Mesh).Count;
            Check(result.fanTriangles == 107 && result.fanOpenEdges == 15, "Fan Fill did not close exactly one side defect.");
            Check(before.clip.name == "Bend" && after.clip.name == "Bend" && Mathf.Abs(after.clip.length-before.clip.length) < Tolerance,
                "The exported clip changed.");
            var a = before.Mesh.vertices;
            var b = after.Mesh.vertices;
            var center = Array.FindIndex(b, point => a.All(value => Vector3.Distance(point, value) >= Tolerance));
            Check(center >= 0, "The Fan center is missing.");
            var w = after.Mesh.boneWeights[center];
            var bones = after.skin.bones;
            Check(bones[w.boneIndex0].name == "Base" && bones[w.boneIndex1].name == "Neck", "Unexpected Fan joints.");
            result.baseWeight = w.weight0;
            result.neckWeight = w.weight1;
            Check(Mathf.Abs(result.baseWeight - 5f / 6f) < Tolerance && Mathf.Abs(result.neckWeight - 1f / 6f) < Tolerance,
                "Fan weights are not the normalized boundary interpolation.");
            int[] matches = a.Select(point => Array.FindIndex(b, value => Vector3.Distance(point, value) < Tolerance)).ToArray();
            Check(matches.All(i => i >= 0), "A boundary or source vertex moved.");
            var rest = Bake(after.skin)[center];
            var bind = after.Mesh.bindposes;
            for (int i = 0; i <= 20; i++) {
                before.clip.SampleAnimation(before.root, i * before.clip.length / 20f);
                after.clip.SampleAnimation(after.root, i * after.clip.length / 20f);
                var oldPose = Bake(before.skin);
                var newPose = Bake(after.skin);
                for (int p = 0; p < matches.Length; p++) {
                    result.maxBasePoseError = Mathf.Max(result.maxBasePoseError, Vector3.Distance(oldPose[p], newPose[matches[p]]));
                }
                var expected = (bones[w.boneIndex0].localToWorldMatrix * bind[w.boneIndex0]).MultiplyPoint3x4(b[center]) * w.weight0 +
                    (bones[w.boneIndex1].localToWorldMatrix * bind[w.boneIndex1]).MultiplyPoint3x4(b[center]) * w.weight1;
                result.maxCenterPoseError = Mathf.Max(result.maxCenterPoseError, Vector3.Distance(expected, newPose[center]));
                result.centerMotion = Mathf.Max(result.centerMotion, Vector3.Distance(rest, newPose[center]));
                result.poseSamples++;
            }
            Check(result.maxBasePoseError < Tolerance && result.maxCenterPoseError < Tolerance && result.centerMotion > .005f,
                "The rig or inserted center did not deform as expected.");
        }
        File.WriteAllText("e05-unity-report.json", JsonUtility.ToJson(result, true));
    }

    static List<(Vector3, Vector3)> OpenEdges(Mesh mesh)
    {
        var points = mesh.vertices;
        var unique = points.Distinct().ToArray();
        var ids = unique.Select((p, i) => (p, i)).ToDictionary(row => row.p, row => row.i);
        var measures = new Dictionary<(int, int), int>();
        var indices = mesh.triangles;
        for (int i = 0; i < indices.Length; i += 3) for (int j = 0; j < 3; j++) {
            int a = ids[points[indices[i + j]]], b = ids[points[indices[i + (j + 1) % 3]]];
            var key = (Math.Min(a, b), Math.Max(a, b));
            measures.TryGetValue(key, out int count);
            measures[key] = count + 1;
        }
        Check(measures.Values.All(count => count <= 2), "The patch introduced a non-manifold edge.");
        return measures.Where(pair => pair.Value == 1).Select(pair => (unique[pair.Key.Item1], unique[pair.Key.Item2])).ToList();
    }

    static Vector3[] Bake(SkinnedMeshRenderer renderer)
    {
        var mesh = new Mesh();
        try {
            renderer.BakeMesh(mesh, false);
            return mesh.vertices.Select(renderer.transform.TransformPoint).ToArray();
        } finally { UnityEngine.Object.DestroyImmediate(mesh); }
    }

    static void Check(bool pass, string message)
    {
        if (!pass) throw new InvalidOperationException(message);
    }
}
