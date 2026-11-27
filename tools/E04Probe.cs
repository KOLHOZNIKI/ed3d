using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class E04Probe
{
    const float Tolerance = 2e-5f;

    [Serializable] sealed class Report
    {
        public string unityVersion;
        public int staticTriangles, splitTriangles, filledTriangles, skinTriangles, poseSamples, sharedRenderers;
        public float splitUvGap, splitNormalAngle, sourceMotion, maxOldVertexPoseError, maxSeparatedPoseError;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject root;
        public readonly AnimationClip clip;
        public readonly SkinnedMeshRenderer[] skin;
        public Model(string name)
        {
            var path = Directory.GetFiles("Assets/Fixtures/" + name, "*.fbx").Single().Replace('\\', '/');
            root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            skin = root.GetComponentsInChildren<SkinnedMeshRenderer>();
            clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                .SingleOrDefault(take => !take.name.StartsWith("__preview__", StringComparison.Ordinal));
        }
        public Mesh StaticMesh() {
            var filter = root.GetComponentInChildren<MeshFilter>();
            Check(filter.GetComponent<MeshRenderer>().sharedMaterial.GetTexture("_MainTex") != null, "Missing linked Base Color.");
            return filter.sharedMesh;
        }
        public void Dispose() => UnityEngine.Object.DestroyImmediate(root);
    }

    public static void Run()
    {
        var result = new Report { unityVersion = Application.unityVersion };
        using (var original = new Model("seams-e04-source"))
        using (var moved = new Model("seams-e04-moved"))
        using (var split = new Model("seams-e04-split"))
        using (var undo = new Model("seams-e04-undo"))
        using (var filled = new Model("holes-filled")) {
            var a = original.StaticMesh();
            var b = moved.StaticMesh();
            var c = split.StaticMesh();
            var d = undo.StaticMesh();
            result.staticTriangles = b.triangles.Length / 3;
            result.splitTriangles = c.triangles.Length / 3;
            result.filledTriangles = filled.StaticMesh().triangles.Length / 3;
            Check(result.staticTriangles == 13 && result.splitTriangles == 15 && result.filledTriangles == 33, "Unexpected triangle totals.");
            var origin = Array.FindAll(b.vertices, p => p.magnitude < Tolerance);
            var displaced = Array.FindAll(b.vertices, p => Vector3.Distance(p, new Vector3(0, .03125f, 0)) < Tolerance);
            Check(origin.Length >= 1 && displaced.Length >= 3 && a.vertices.Count(p => p.magnitude < Tolerance) == origin.Length + displaced.Length,
                "The seam move changed an independent vertex or missed some corner copies.");
            Check(b.vertices.SequenceEqual(d.vertices) && b.triangles.SequenceEqual(d.triangles) && b.uv.SequenceEqual(d.uv) &&
                b.normals.SequenceEqual(d.normals), "Undo changed a corner attribute.");
            var copies = Enumerable.Range(0, c.vertexCount).Where(i => Mathf.Abs(Mathf.Abs(c.vertices[i].x) - .5f) < Tolerance &&
                Mathf.Abs(c.vertices[i].y - .015625f) < Tolerance && Mathf.Abs(c.vertices[i].z) < Tolerance).ToArray();
            var uv = c.uv;
            var normal = c.normals;
            foreach (var i in copies) foreach (var j in copies) {
                result.splitUvGap = Mathf.Max(result.splitUvGap, Vector2.Distance(uv[i], uv[j]));
                result.splitNormalAngle = Mathf.Max(result.splitNormalAngle, Vector3.Angle(normal[i], normal[j]));
            }
            Check(copies.Length >= 2 && result.splitUvGap > .1f && result.splitNormalAngle > 80f, "The split lost UV duplication or the hard normal.");
        }
        using (var source = new Model("skin-source"))
        using (var edited = new Model("skin-split"))
        using (var separate = new Model("skin-separated")) {
            var a = source.skin.Single();
            var b = edited.skin.Single();
            result.skinTriangles = b.sharedMesh.triangles.Length / 3;
            result.sharedRenderers = separate.skin.Length;
            Check(result.skinTriangles == 6 && result.sharedRenderers == 2 &&
                separate.skin[0].bones.SequenceEqual(separate.skin[1].bones), "The exported pieces do not use the same bones.");
            Check(new[] { source, edited, separate }.All(model => model.clip.name == "Bend" && Mathf.Abs(model.clip.length - 1f) < Tolerance),
                "The clip name or duration changed.");
            Check(edited.skin.Concat(separate.skin).All(renderer => renderer.sharedMaterial.GetTexture("_MainTex") != null), "Missing skin Base Color.");
            var mid = Array.FindIndex(b.sharedMesh.vertices, p => Vector3.Distance(new Vector3(0, .5f, 0), p) < Tolerance);
            Check(mid >= 0, "The skinned midpoint is missing.");
            var weight = b.sharedMesh.boneWeights[mid];
            Check(b.bones[weight.boneIndex0].name == "Base" && b.bones[weight.boneIndex1].name == "Elbow" &&
                Mathf.Abs(weight.weight0 - .75f) < Tolerance && Mathf.Abs(weight.weight1 - .25f) < Tolerance,
                "The midpoint skin weights were not interpolated.");
            var rest = WorldPose(a);
            var oldPoints = Match(a, b);
            var pieces = separate.skin.Select(piece => Match(piece, b)).ToArray();
            for (int i = 0; i <= 20; i++) {
                var time = i / 20f;
                foreach (var model in new[] { source, edited, separate }) model.clip.SampleAnimation(model.root, time);
                var before = WorldPose(a);
                var after = WorldPose(b);
                result.sourceMotion = Mathf.Max(result.sourceMotion, Delta(before, rest, Enumerable.Range(0, before.Length).ToArray()));
                result.maxOldVertexPoseError = Mathf.Max(result.maxOldVertexPoseError, Delta(before, after, oldPoints));
                for (int j = 0; j < pieces.Length; j++)
                    result.maxSeparatedPoseError = Mathf.Max(result.maxSeparatedPoseError, Delta(WorldPose(separate.skin[j]), after, pieces[j]));
                result.poseSamples++;
            }
            Check(result.sourceMotion > .1f && result.maxOldVertexPoseError < Tolerance && result.maxSeparatedPoseError < Tolerance,
                "Skin deformation changed after the split or separate.");
        }
        File.WriteAllText("e04-unity-report.json", JsonUtility.ToJson(result, true));
    }

    static int[] Match(SkinnedMeshRenderer a, SkinnedMeshRenderer b)
    {
        var points = b.sharedMesh.vertices;
        return a.sharedMesh.vertices.Select(point => {
            int match = Array.FindIndex(points, other => Vector3.Distance(point, other) < Tolerance);
            Check(match >= 0, "An original position was lost.");
            return match;
        }).ToArray();
    }

    static Vector3[] WorldPose(SkinnedMeshRenderer renderer)
    {
        var mesh = new Mesh();
        try {
            renderer.BakeMesh(mesh, false);
            return mesh.vertices.Select(renderer.transform.TransformPoint).ToArray();
        } finally { UnityEngine.Object.DestroyImmediate(mesh); }
    }

    static float Delta(Vector3[] a, Vector3[] b, int[] map) =>
        a.Select((p, i) => Vector3.Distance(p, b[map[i]])).Max();

    static void Check(bool test, string detail)
    {
        if (!test) throw new InvalidOperationException(detail);
    }
}
