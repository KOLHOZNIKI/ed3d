using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class RepairProbe
{
    [Serializable] sealed class Removed
    {
        public int[] vertices;
        public Vector2[] uv;
    }

    [Serializable] sealed class Patch
    {
        public int center;
        public string method;
        public int[] boundary;
        public Vector3[] boundaryPositions;
        public float[] before, after;
        public Removed[] removed;
    }

    [Serializable] sealed class Report
    {
        public string unityVersion;
        public Result[] results;
    }

    [Serializable] sealed class Result
    {
        public string method;
        public int triangles, patchTriangles, unchangedOutsideTriangles, sharedBoundaryEdges, centerUvCopies;
        public float centerDisplacementMeters, maxPositionErrorMeters, maxCornerUvError;
        public bool linkedBaseColor;
    }

    sealed class Model
    {
        public readonly Vector3[] positions;
        public readonly Vector2[] uv;
        public readonly int[] indices;
        public readonly bool linkedBaseColor;
        public readonly Transform transform;

        public Model(string directory)
        {
            var path = Directory.GetFiles(directory, "*.fbx").Single().Replace('\\', '/');
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) throw new InvalidOperationException($"Unity did not import {path}.");
            var model = prefab.GetComponentInChildren<MeshFilter>();
            var material = model.GetComponent<MeshRenderer>().sharedMaterial;
            var mesh = model.sharedMesh;
            linkedBaseColor = material != null && material.HasProperty("_MainTex") && material.GetTexture("_MainTex") != null;
            positions = mesh.vertices;
            uv = mesh.uv;
            indices = mesh.triangles;
            transform = model.transform;
            if (positions.Length != uv.Length) throw new InvalidOperationException("The mesh has missing UV corners.");
        }
    }

    public static void Run()
    {
        var results = new List<Result>();
        foreach (var folder in Directory.GetDirectories("Assets/Fixtures").OrderBy(path => path, StringComparer.Ordinal)) {
            var patch = JsonUtility.FromJson<Patch>(File.ReadAllText(Path.Combine(folder, "repair.json")));
            results.Add(Compare(new Model(Path.Combine(folder, "original")), new Model(Path.Combine(folder, "exported")), patch));
        }
        if (results.Count != 2) throw new InvalidOperationException("Both repair methods are required.");
        File.WriteAllText("repair-report.json", JsonUtility.ToJson(new Report { unityVersion = Application.unityVersion, results = results.ToArray() }, true));
    }

    static Result Compare(Model original, Model exported, Patch patch)
    {
        bool smooth = patch.method == "smooth";
        var result = new Result { method = patch.method, triangles = exported.indices.Length / 3, linkedBaseColor = exported.linkedBaseColor };
        var before = Point(patch.before);
        var after = Point(patch.after);
        var coordinates = patch.boundary.Zip(patch.boundaryPositions, (id, value) => (id, value)).ToDictionary(pair => pair.id, pair => pair.value);
        coordinates.Add(patch.center, before);
        var sign = new[] { 1f, -1f }.Single(x => patch.removed.All(face => face.vertices.Select((id, k) => (id, k))
            .All(corner => HasCorner(original, Flip(coordinates[corner.id], x), face.uv[corner.k]))));
        var beforeCoordinates = coordinates.ToDictionary(p => p.Key, p => Flip(p.Value, sign));
        var afterCoordinates = new Dictionary<int, Vector3>(beforeCoordinates) { [patch.center] = Flip(after, sign) };

        var left = Partition(original, patch, beforeCoordinates);
        var right = Partition(exported, patch, afterCoordinates);
        Require(left.outside.OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(right.outside.OrderBy(x => x, StringComparer.Ordinal)),
            "Outside triangle connectivity, positions or UVs changed.");
        result.unchangedOutsideTriangles = right.outside.Count;
        var seamUvs = new HashSet<Vector2>();
        for (int face = 0; face < patch.removed.Length; face++) {
            var removed = patch.removed[face];
            var triangles = right.inside[face];
            Require(left.inside[face].Count == 2 && triangles.Count == 2, "Each repaired quad sector must import as two triangles.");
            var edges = new Dictionary<(int, int), int>();
            foreach (var triangle in triangles) {
                for (int k = 0; k < 3; k++) {
                    var id = triangle.ids[k];
                    var vertex = triangle.vertices[k];
                    var expected = removed.uv[Array.IndexOf(removed.vertices, id)];
                    result.maxCornerUvError = Mathf.Max(result.maxCornerUvError, Vector2.Distance(exported.uv[vertex], expected));
                    result.maxPositionErrorMeters = Mathf.Max(result.maxPositionErrorMeters,
                        Vector3.Distance(exported.transform.TransformPoint(exported.positions[vertex]),
                                         exported.transform.TransformPoint(afterCoordinates[id])));
                    if (id == patch.center) seamUvs.Add(exported.uv[vertex]);
                    AddEdge(edges, id, triangle.ids[(k + 1) % 3]);
                }
                result.patchTriangles++;
            }
            int diagonals = 0;
            foreach (var edge in edges) {
                var a = Array.IndexOf(removed.vertices, edge.Key.Item1);
                var b = Array.IndexOf(removed.vertices, edge.Key.Item2);
                bool diagonal = Math.Abs(a - b) == 2;
                Require(edge.Value == (diagonal ? 2 : 1), "Repair triangle edges do not cover their source quad.");
                if (!diagonal) continue;
                diagonals++;
                Require(!smooth || edge.Key.Item1 == patch.center || edge.Key.Item2 == patch.center,
                    "Smooth Fill must retain its center-to-corner fan.");
            }
            Require(edges.Count == 5 && diagonals == 1, "The repaired sector has a missing or duplicate triangle.");
        }
        for (int i = 0; i < patch.boundary.Length; i++) {
            var edge = Edge(patch.boundary[i], patch.boundary[(i + 1) % patch.boundary.Length]);
            Require(right.outerEdges.TryGetValue(edge, out int count) && count == 1, "A repaired edge does not join the surrounding mesh.");
            result.sharedBoundaryEdges++;
        }
        result.centerUvCopies = seamUvs.Count;
        result.centerDisplacementMeters = Vector3.Distance(original.transform.TransformPoint(beforeCoordinates[patch.center]),
            exported.transform.TransformPoint(afterCoordinates[patch.center]));
        Require(result.sharedBoundaryEdges == 8 && result.patchTriangles == 8 && result.centerUvCopies > 1 &&
            result.centerDisplacementMeters > 0.0005f && result.maxPositionErrorMeters < 1e-6f &&
            result.maxCornerUvError <= 1e-7f && result.linkedBaseColor, "The imported repair differs from the expected patch.");
        return result;
    }

    static (List<string> outside, List<(int[] ids, int[] vertices)>[] inside, Dictionary<(int, int), int> outerEdges)
        Partition(Model model, Patch patch, Dictionary<int, Vector3> coordinates)
    {
        var ids = Enumerable.Repeat(-1, model.positions.Length).ToArray();
        for (int i = 0; i < model.positions.Length; i++) {
            foreach (var point in coordinates) if (Vector3.Distance(model.positions[i], point.Value) < 1e-6f) ids[i] = point.Key;
        }
        var outside = new List<string>();
        var edges = new Dictionary<(int, int), int>();
        var inside = patch.removed.Select(_ => new List<(int[], int[])>()).ToArray();
        for (int k = 0; k < model.indices.Length; k += 3) {
            var triangle = new[] { model.indices[k], model.indices[k + 1], model.indices[k + 2] };
            var control = triangle.Select(i => ids[i]).ToArray();
            var face = Array.FindIndex(patch.removed, q => control.All(id => Array.IndexOf(q.vertices, id) >= 0));
            if (face >= 0) {
                inside[face].Add((control, triangle));
                continue;
            }
            var corners = triangle.Select(i => CornerKey(model.positions[i], model.uv[i])).ToArray();
            var first = Array.IndexOf(corners, corners.OrderBy(value => value, StringComparer.Ordinal).First());
            outside.Add(string.Join("/", Enumerable.Range(0, 3).Select(i => corners[(first + i) % 3])));
            for (int i = 0; i < 3; i++) if (control[i] >= 0 && control[(i + 1) % 3] >= 0) AddEdge(edges, control[i], control[(i + 1) % 3]);
        }
        return (outside, inside, edges);
    }

    static string CornerKey(Vector3 p, Vector2 uv) => FormattableString.Invariant($"{p.x:R},{p.y:R},{p.z:R}|{uv.x:R},{uv.y:R}");
    static Vector3 Point(float[] p) => new Vector3(p[0], p[1], p[2]);
    static Vector3 Flip(Vector3 p, float sign) => new Vector3(p.x * sign, p.y, p.z);
    static (int, int) Edge(int a, int b) => a < b ? (a, b) : (b, a);

    static bool HasCorner(Model model, Vector3 position, Vector2 uv)
    {
        for (int i = 0; i < model.positions.Length; i++) {
            if (Vector3.Distance(position, model.positions[i]) < 1e-6f && Vector2.Distance(uv, model.uv[i]) <= 1e-7f) return true;
        }
        return false;
    }

    static void AddEdge(Dictionary<(int, int), int> edges, int a, int b)
    {
        var edge = Edge(a, b);
        edges.TryGetValue(edge, out int previous);
        edges[edge] = previous + 1;
    }

    static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
