using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class E07Probe
{
    const float Tolerance = 0.00003f;

    [Serializable] sealed class Report
    {
        public string unityVersion;
        public int assemblyTriangles, rebasedTriangles;
        public float worldError, bottomPivotError, rebasedOriginError, rebasedRotationScaleError, scaleMultiplier;
    }

    sealed class Instance : IDisposable
    {
        readonly GameObject root;
        public readonly MeshFilter filter;
        public readonly Mesh mesh;

        public Instance(string folder)
        {
            var path = Directory.GetFiles("Assets/Fixtures/" + folder, "*.fbx").Single().Replace('\\', '/');
            root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            filter = root.GetComponentsInChildren<MeshFilter>().Single();
            mesh = filter.sharedMesh;
            var material = filter.GetComponent<MeshRenderer>().sharedMaterial;
            if (material == null || material.mainTexture == null || mesh.uv.Length != mesh.vertexCount)
                throw new InvalidOperationException("The FBX lost its Base Color binding or UVs.");
        }

        public Vector3[] World() => mesh.vertices.Select(filter.transform.TransformPoint).ToArray();
        public void Dispose() => UnityEngine.Object.DestroyImmediate(root);
    }

    public static void Run()
    {
        using (var input = new Instance("batch"))
        using (var assembly = new Instance("assembly"))
        using (var rebased = new Instance("rebased")) {
            var original = input.World();
            var selected = SelectTile(input, 0, 1, 2);
            var result = assembly.World();
            var low = selected.Aggregate(Vector3.Min);
            var high = selected.Aggregate(Vector3.Max);
            var bottom = new Vector3((low.x + high.x) / 2, low.y, (low.z + high.z) / 2);
            var tile = SelectTile(input, 3);
            var center = (tile.Aggregate(Vector3.Min) + tile.Aggregate(Vector3.Max)) / 2;
            var axis = input.filter.transform.TransformDirection(Vector3.forward);
            var rebasedPoints = rebased.World();
            float TransformError(float angle) {
                var rotation = Quaternion.AngleAxis(angle, axis);
                return Match(tile.Select(p => 2 * (rotation * (p - center))).ToArray(), rebasedPoints);
            }
            var report = new Report {
                unityVersion = Application.unityVersion,
                assemblyTriangles = assembly.mesh.triangles.Length / 3, rebasedTriangles = rebased.mesh.triangles.Length / 3,
                worldError = Match(selected, result), bottomPivotError = Vector3.Distance(assembly.filter.transform.position, bottom),
                rebasedOriginError = rebased.filter.transform.position.magnitude,
                rebasedRotationScaleError = Mathf.Min(TransformError(30), TransformError(-30)),
                scaleMultiplier = rebased.filter.transform.lossyScale.x / input.filter.transform.lossyScale.x,
            };
            File.WriteAllText("e07-report.json", JsonUtility.ToJson(report, true));
            if (input.mesh.triangles.Length != 108 || original.Length != 72 || selected.Length != 12 || tile.Length != 4 ||
                report.assemblyTriangles != 6 || report.rebasedTriangles != 2 || report.worldError > Tolerance ||
                report.bottomPivotError > Tolerance || report.rebasedOriginError > Tolerance ||
                report.rebasedRotationScaleError > Tolerance || Mathf.Abs(report.scaleMultiplier - 2) > Tolerance)
                throw new InvalidOperationException("Extraction changed the expected geometry, pivot, scale, or orientation.");
        }
    }

    static Vector3[] SelectTile(Instance input, params int[] tiles)
    {
        var uv = input.mesh.uv;
        var points = input.World();
        return points.Where((_, i) => uv[i].y < .25f && tiles.Contains(Mathf.FloorToInt(uv[i].x * 5))).ToArray();
    }

    static float Match(Vector3[] expected, Vector3[] actual)
    {
        if (expected.Length != actual.Length || expected.Length == 0)
            throw new InvalidOperationException("The extracted mesh has a different vertex count.");
        return expected.Max(p => actual.Min(q => Vector3.Distance(p, q)));
    }
}
