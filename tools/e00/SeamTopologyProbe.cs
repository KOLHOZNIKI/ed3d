using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public static class SeamTopologyProbe
{
    const float PositionTolerance = 1e-6f, UvTolerance = 1e-6f, NormalTolerance = 0.1f;

    [Serializable] sealed class Edit { public float offsetY; }
    [Serializable] sealed class Report
    {
        public string unityVersion;
        public bool rejectsMissingEdit;
        public Comparison baseline, edited;
    }
    [Serializable] sealed class Comparison
    {
        public bool passed, boundChecker, sourceCoincidentAttributes, independentUnityIndices;
        public int originalVertices, exportedVertices, targetTriangleCorners, targetVertexCopies, targetUvVariants;
        public float observedTargetOffsetY, coincidentPointMovement, minUvSeamGap, minHardNormalAngle;
        public float maxPositionError, maxCornerUvError, maxCornerNormalAngle;
    }

    struct Corner
    {
        public int index;
        public Vector3 position, normal;
        public Vector2 uv;
    }

    sealed class Model
    {
        public readonly Corner[][] triangles;
        public readonly int vertexCount;
        public readonly bool boundChecker;

        public Model(string directory)
        {
            var path = Directory.GetFiles(directory, "*.fbx").Single().Replace('\\', '/');
            var importer = (ModelImporter)AssetImporter.GetAtPath(path);
            if (importer.weldVertices || importer.importNormals != ModelImporterNormals.Import ||
                importer.meshCompression != ModelImporterMeshCompression.Off)
                throw new InvalidOperationException($"Unexpected importer settings for {path}.");
            var root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            try {
                var filter = root.GetComponentsInChildren<MeshFilter>().Single();
                var mesh = filter.sharedMesh;
                var material = filter.GetComponent<MeshRenderer>().sharedMaterial;
                boundChecker = material != null && material.mainTexture != null;
                vertexCount = mesh.vertexCount;
                var positions = mesh.vertices;
                var normals = mesh.normals;
                var uvs = mesh.uv;
                var indices = mesh.triangles;
                if (indices.Length != 39 || normals.Length != vertexCount || uvs.Length != vertexCount)
                    throw new InvalidOperationException($"Expected 13 triangles with UVs and normals in {path}.");
                triangles = new Corner[13][];
                for (int triangle = 0; triangle < triangles.Length; triangle++) {
                    triangles[triangle] = new Corner[3];
                    for (int corner = 0; corner < 3; corner++) {
                        int i = indices[3 * triangle + corner];
                        triangles[triangle][corner] = new Corner {
                            index = i,
                            position = filter.transform.TransformPoint(positions[i]),
                            normal = filter.transform.TransformDirection(normals[i]),
                            uv = uvs[i],
                        };
                    }
                }
            } finally {
                UnityEngine.Object.DestroyImmediate(root);
            }
        }
    }

    public static void Run()
    {
        var edit = JsonUtility.FromJson<Edit>(File.ReadAllText("topology-seams.json"));
        if (!(edit.offsetY > 0f)) throw new InvalidOperationException("Expected a positive fixture edit.");
        var source = new Model("Assets/Fixtures/seams-baseline/original");
        var unchanged = new Model("Assets/Fixtures/seams-baseline/exported");
        var edited = new Model("Assets/Fixtures/seams-edited/exported");
        var report = new Report {
            unityVersion = Application.unityVersion,
            baseline = Compare(source, unchanged, 0f),
            edited = Compare(source, edited, edit.offsetY),
            rejectsMissingEdit = !Compare(source, unchanged, edit.offsetY).passed,
        };
        File.WriteAllText("topology-seams-report.json", JsonUtility.ToJson(report, true));
        if (!report.baseline.passed || !report.edited.passed || !report.rejectsMissingEdit)
            throw new InvalidOperationException("The topology seam check failed. See topology-seams-report.json.");
        Debug.Log("Verified both F01/F02 exports. See topology-seams-report.json.");
    }

    static Comparison Compare(Model source, Model output, float offsetY)
    {
        var result = new Comparison {
            boundChecker = source.boundChecker && output.boundChecker,
            originalVertices = source.vertexCount,
            exportedVertices = output.vertexCount,
        };
        // The detached triangle alone has a corner below the cube. Its coincident corner shares the cube's origin.
        var witness = source.triangles.Single(face => face.Any(corner => corner.position.y < -0.5f));
        var originalTarget = new List<Corner>();
        var exportedTarget = new List<Corner>();
        var originalWitness = new List<Corner>();
        var exportedWitness = new List<Corner>();
        var remaining = new List<Corner[]>(output.triangles);
        foreach (var triangle in source.triangles) {
            var targetCorners = triangle.Select(corner => corner.position.sqrMagnitude <= PositionTolerance * PositionTolerance).ToArray();
            var expected = (Corner[])triangle.Clone();
            for (int i = 0; i < 3; i++)
                if (targetCorners[i] && triangle != witness) expected[i].position.y += offsetY;

            // Keep the winding while allowing Unity to reorder triangles and start a face at another corner.
            Corner[] match = null;
            int start = 0;
            foreach (var candidate in remaining) {
                for (int j = 0; j < 3; j++) {
                    if (!Enumerable.Range(0, 3).All(i => Matches(expected[i], candidate[(i + j) % 3]))) continue;
                    match = candidate;
                    start = j;
                    break;
                }
                if (match != null) break;
            }
            if (match == null) return result;
            remaining.Remove(match);
            for (int i = 0; i < 3; i++) {
                var actual = match[(i + start) % 3];
                result.maxPositionError = Mathf.Max(result.maxPositionError, Vector3.Distance(expected[i].position, actual.position));
                result.maxCornerUvError = Mathf.Max(result.maxCornerUvError, Vector2.Distance(expected[i].uv, actual.uv));
                result.maxCornerNormalAngle = Mathf.Max(result.maxCornerNormalAngle, Vector3.Angle(expected[i].normal, actual.normal));
                if (!targetCorners[i]) continue;
                (triangle == witness ? originalWitness : originalTarget).Add(triangle[i]);
                (triangle == witness ? exportedWitness : exportedTarget).Add(actual);
                if (triangle == witness) result.coincidentPointMovement = Vector3.Distance(triangle[i].position, actual.position);
            }
        }

        if (originalWitness.Count != 1 || originalTarget.Count != 6 || remaining.Count != 0) return result;
        var seam = exportedTarget.GroupBy(corner => corner.uv).Select(group => group.First()).ToArray();
        result.sourceCoincidentAttributes = originalTarget.Any(corner => Matches(corner, originalWitness[0]));
        result.independentUnityIndices = originalTarget.All(corner => corner.index != originalWitness[0].index) &&
            exportedTarget.All(corner => corner.index != exportedWitness[0].index);
        result.targetTriangleCorners = exportedTarget.Count;
        result.targetVertexCopies = exportedTarget.Select(corner => corner.index).Distinct().Count();
        result.targetUvVariants = seam.Length;
        result.observedTargetOffsetY = exportedTarget[0].position.y - originalTarget[0].position.y;
        if (seam.Length != 3) return result;
        result.minUvSeamGap = Mathf.Min(Vector2.Distance(seam[0].uv, seam[1].uv), Vector2.Distance(seam[0].uv, seam[2].uv),
            Vector2.Distance(seam[1].uv, seam[2].uv));
        result.minHardNormalAngle = Mathf.Min(Vector3.Angle(seam[0].normal, seam[1].normal), Vector3.Angle(seam[0].normal, seam[2].normal),
            Vector3.Angle(seam[1].normal, seam[2].normal));
        result.passed = result.boundChecker && result.sourceCoincidentAttributes && result.independentUnityIndices &&
            result.minUvSeamGap > 0.1f && Mathf.Abs(result.minHardNormalAngle - 90f) <= NormalTolerance;
        return result;
    }

    static bool Matches(Corner expected, Corner actual) =>
        Vector3.Distance(expected.position, actual.position) <= PositionTolerance &&
        Vector2.Distance(expected.uv, actual.uv) <= UvTolerance &&
        Vector3.Angle(expected.normal, actual.normal) <= NormalTolerance;
}
