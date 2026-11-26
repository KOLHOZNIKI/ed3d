using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

public sealed class E00ImportSettings : AssetPostprocessor
{
    void OnPreprocessModel()
    {
        if (!assetPath.StartsWith("Assets/Fixtures/", StringComparison.Ordinal) || !assetImporter.importSettingsMissing) return;
        var importer = (ModelImporter)assetImporter;
        importer.animationType = ModelImporterAnimationType.Generic;
        importer.animationCompression = ModelImporterAnimationCompression.Off;
        importer.meshCompression = ModelImporterMeshCompression.Off;
        importer.optimizeMeshVertices = false;
        importer.optimizeMeshPolygons = false;
        importer.importNormals = ModelImporterNormals.Import;
        importer.importTangents = ModelImporterTangents.CalculateMikk;
        importer.skinWeights = ModelImporterSkinWeights.Standard;
        importer.useFileScale = true;
        importer.bakeAxisConversion = false;
        importer.isReadable = true;
        importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
    }
}

public static class FbxProbe
{
    [Serializable] sealed class Report
    {
        public string unityVersion;
        public Pair[] comparisons;
    }

    [Serializable] sealed class Pair
    {
        public string fixture;
        public bool compatible;
        public AssetInfo original, exported;
        public float tolerance, baseError, maxWeightError, restError, maxPoseError, originalMotion;
        public float maxClipError, maxClipDurationError, originalClipMotion;
        public int clipSamples;
        public string testedBone;
        public bool originalHumanoidAvatar, exportedHumanoidAvatar;
        public int editedVertexCopies, editedUvCopies;
        public float observedMove, maxUvError;
        public bool sameTriangleConnectivity;
    }

    [Serializable] sealed class PositionEdit
    {
        public float offsetY;
    }

    [Serializable] sealed class AssetInfo
    {
        public int vertices, triangles, bones, bindPoses, boundBaseColor, boundNormal;
        public string[] boneNames, clips, materials;
        public float[] clipDurations;
        public Vector3 min, max;
    }

    sealed class Model : IDisposable
    {
        public readonly GameObject root;
        public readonly Mesh mesh;
        public readonly Transform meshTransform;
        public readonly SkinnedMeshRenderer skin;
        public readonly AnimationClip[] clips;
        public readonly Vector3[] basePoints;
        public readonly AssetInfo info;
        Mesh poseMesh;

        public Model(string path)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) throw new InvalidOperationException($"Unity did not import {path}");
            root = UnityEngine.Object.Instantiate(prefab);
            skin = root.GetComponentInChildren<SkinnedMeshRenderer>();
            var filter = root.GetComponentInChildren<MeshFilter>();
            mesh = skin != null ? skin.sharedMesh : filter.sharedMesh;
            meshTransform = skin != null ? skin.transform : filter.transform;
            clips = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>()
                .Where(clip => !clip.name.StartsWith("__preview__", StringComparison.Ordinal))
                .OrderBy(clip => clip.name, StringComparer.Ordinal).ToArray();
            basePoints = WorldPoints(mesh);
            var bounds = new Bounds(basePoints[0], Vector3.zero);
            foreach (var point in basePoints) bounds.Encapsulate(point);
            var materials = meshTransform.GetComponent<Renderer>().sharedMaterials.Where(material => material != null).ToArray();
            info = new AssetInfo {
                vertices = mesh.vertexCount, triangles = mesh.triangles.Length / 3,
                bones = skin != null ? skin.bones.Length : 0, bindPoses = mesh.bindposes.Length,
                boneNames = skin != null ? skin.bones.Select(bone => bone.name).OrderBy(name => name, StringComparer.Ordinal).ToArray() : Array.Empty<string>(),
                clips = clips.Select(clip => clip.name).ToArray(), clipDurations = clips.Select(clip => clip.length).ToArray(),
                materials = materials.Select(material => material.name).ToArray(),
                boundBaseColor = materials.Count(material => material.HasProperty("_MainTex") && material.GetTexture("_MainTex") != null),
                boundNormal = materials.Count(material => material.HasProperty("_BumpMap") && material.GetTexture("_BumpMap") != null),
                min = bounds.min, max = bounds.max,
            };
        }

        public Vector3[] PosedPoints()
        {
            var baked = new Mesh();
            try {
                skin.BakeMesh(baked, false);
                return WorldPoints(baked);
            } finally {
                UnityEngine.Object.DestroyImmediate(baked);
            }
        }

        public void ApplyPoseProbeMove(int[] indices, Vector3 worldOffset)
        {
            poseMesh = UnityEngine.Object.Instantiate(mesh);
            var vertices = poseMesh.vertices;
            var localOffset = meshTransform.InverseTransformVector(worldOffset);
            foreach (int index in indices) vertices[index] += localOffset;
            poseMesh.vertices = vertices;
            skin.sharedMesh = poseMesh;
        }

        Vector3[] WorldPoints(Mesh source) => source.vertices.Select(meshTransform.TransformPoint).ToArray();
        public void Dispose()
        {
            UnityEngine.Object.DestroyImmediate(root);
            if (poseMesh != null) UnityEngine.Object.DestroyImmediate(poseMesh);
        }
    }

    public static void Run()
    {
        var fixtures = Directory.GetDirectories("Assets/Fixtures").OrderBy(name => name, StringComparer.Ordinal);
        var comparisons = new List<Pair>();
        foreach (var fixture in fixtures) {
            var input = Directory.GetFiles(Path.Combine(fixture, "original"), "*.fbx").Single();
            var output = Directory.GetFiles(Path.Combine(fixture, "exported"), "*.fbx").Single();
            input = input.Replace('\\', '/');
            output = output.Replace('\\', '/');
            var editPath = Path.Combine(fixture, "position-edit.json");
            var edit = File.Exists(editPath) ? JsonUtility.FromJson<PositionEdit>(File.ReadAllText(editPath)) : null;
            Pair comparison;
            using (var original = new Model(input))
            using (var exported = new Model(output)) {
                comparison = Compare(Path.GetFileName(fixture), original, exported, edit);
            }
            if (comparison.fixture.StartsWith("skinned", StringComparison.Ordinal)) {
                comparison.originalHumanoidAvatar = HasHumanoidAvatar(input);
                comparison.exportedHumanoidAvatar = HasHumanoidAvatar(output);
            }
            comparisons.Add(comparison);
        }
        var report = new Report { unityVersion = Application.unityVersion, comparisons = comparisons.ToArray() };
        File.WriteAllText("e00-report.json", JsonUtility.ToJson(report, true));
        Debug.Log($"E00 measured {comparisons.Count} FBX pairs. See e00-report.json.");
    }

    static Pair Compare(string fixture, Model before, Model after, PositionEdit edit)
    {
        float diagonal = Vector3.Distance(before.info.min, before.info.max);
        float tolerance = Mathf.Max(1e-6f, 1e-4f * diagonal);
        var result = new Pair { fixture = fixture, original = before.info, exported = after.info, tolerance = tolerance };
        var baseTolerance = Mathf.Max(1e-7f, 1e-5f * diagonal);
        var expected = before.basePoints;
        Vector2[] beforeUv = null, afterUv = null;
        var positionTolerance = edit == null ? tolerance : baseTolerance;
        int[] moved = null;
        var worldOffset = Vector3.zero;
        if (edit != null) {
            beforeUv = before.mesh.uv;
            afterUv = after.mesh.uv;
            var unchanged = MatchPoints(before.basePoints, after.basePoints, baseTolerance);
            moved = Enumerable.Range(0, unchanged.Length).Where(index => unchanged[index] < 0).ToArray();
            result.editedVertexCopies = moved.Length;
            if (moved.Length == 0 || moved.Any(index => Vector3.Distance(before.basePoints[index], before.basePoints[moved[0]]) > baseTolerance)
                || beforeUv.Length != before.basePoints.Length || afterUv.Length != after.basePoints.Length) {
                result.baseError = -1;
                return result;
            }
            expected = (Vector3[])before.basePoints.Clone();
            worldOffset = before.meshTransform.TransformVector(Vector3.up * edit.offsetY);
            foreach (int index in moved) expected[index] += worldOffset;
            result.editedUvCopies = moved.Select(index => beforeUv[index]).Distinct().Count();
        }

        var matches = MatchPoints(expected, after.basePoints, positionTolerance, beforeUv, afterUv);
        result.baseError = matches.All(index => index >= 0) ? Delta(expected, after.basePoints, matches) : -1;
        result.compatible = result.baseError >= 0 && result.baseError <= baseTolerance
            && MatchPoints(after.basePoints, expected, baseTolerance, afterUv, beforeUv).All(index => index >= 0)
            && before.info.triangles == after.info.triangles && before.info.boneNames.SequenceEqual(after.info.boneNames)
            && before.info.bindPoses == after.info.bindPoses && before.info.boundBaseColor == after.info.boundBaseColor
            && before.info.boundNormal == after.info.boundNormal && before.info.clips.SequenceEqual(after.info.clips);
        if (edit != null && result.baseError >= 0) {
            result.observedMove = Vector3.Distance(before.basePoints[moved[0]], after.basePoints[matches[moved[0]]]);
            result.maxUvError = Enumerable.Range(0, matches.Length).Max(i => Vector2.Distance(beforeUv[i], afterUv[matches[i]]));
            var canonical = MatchPoints(after.basePoints, after.basePoints, baseTolerance, afterUv, afterUv);
            result.sameTriangleConnectivity = TriangleKeys(before.mesh, i => canonical[matches[i]])
                .SequenceEqual(TriangleKeys(after.mesh, i => canonical[i]));
            result.compatible &= result.editedUvCopies > 1 && result.sameTriangleConnectivity;
        }
        if (before.skin == null || after.skin == null || result.baseError < 0) return result;

        result.maxWeightError = WeightDelta(before, after, matches);
        if (edit != null) before.ApplyPoseProbeMove(moved, worldOffset);
        var rest = before.PosedPoints();
        result.restError = Delta(rest, after.PosedPoints(), matches);
        result.compatible &= result.maxWeightError <= 1e-5f && result.restError <= tolerance;
        var joint = before.skin.bones.FirstOrDefault(bone => bone.name == "Left_LowerArm" || bone.name == "Hinge");
        var identity = Enumerable.Range(0, rest.Length).ToArray();
        if (joint != null) {
            var target = after.skin.bones.FirstOrDefault(bone => bone.name == joint.name);
            if (target == null) { result.compatible = false; return result; }
            result.testedBone = joint.name;
            var originalRotation = joint.localRotation;
            var exportedRotation = target.localRotation;
            foreach (float angle in new[] { -35f, 20f, 55f }) {
                var rotation = Quaternion.AngleAxis(angle, Vector3.forward);
                joint.localRotation = originalRotation * rotation;
                target.localRotation = exportedRotation * rotation;
                var originalPose = before.PosedPoints();
                result.maxPoseError = Mathf.Max(result.maxPoseError, Delta(originalPose, after.PosedPoints(), matches));
                result.originalMotion = Mathf.Max(result.originalMotion, Delta(rest, originalPose, identity));
            }
            joint.localRotation = originalRotation;
            target.localRotation = exportedRotation;
            result.compatible &= result.maxPoseError <= tolerance && result.originalMotion > tolerance;
        }

        for (int clip = 0; clip < Math.Min(before.clips.Length, after.clips.Length); clip++) {
            var sourceClip = before.clips[clip];
            var outputClip = after.clips[clip];
            result.maxClipDurationError = Mathf.Max(result.maxClipDurationError, Mathf.Abs(sourceClip.length - outputClip.length));
            Vector3[] firstPose = null;
            for (int sample = 0; sample <= 20; sample++) {
                sourceClip.SampleAnimation(before.root, sourceClip.length * sample / 20f);
                outputClip.SampleAnimation(after.root, outputClip.length * sample / 20f);
                var pose = before.PosedPoints();
                if (sample == 0) firstPose = pose;
                result.maxClipError = Mathf.Max(result.maxClipError, Delta(pose, after.PosedPoints(), matches));
                result.originalClipMotion = Mathf.Max(result.originalClipMotion, Delta(firstPose, pose, identity));
                result.clipSamples++;
            }
        }
        result.compatible &= result.maxClipDurationError <= 1e-5f && result.maxClipError <= tolerance
            && (joint != null || result.clipSamples > 0) && (result.clipSamples == 0 || result.originalClipMotion > tolerance);
        return result;
    }

    static bool HasHumanoidAvatar(string path)
    {
        var importer = (ModelImporter)AssetImporter.GetAtPath(path);
        var originalType = importer.animationType;
        var originalSetup = importer.avatarSetup;
        try {
            importer.animationType = ModelImporterAnimationType.Human;
            importer.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
            importer.SaveAndReimport();
            return AssetDatabase.LoadAllAssetsAtPath(path).OfType<Avatar>().Any(avatar => avatar.isValid && avatar.isHuman);
        } finally {
            importer.animationType = originalType;
            importer.avatarSetup = originalSetup;
            importer.SaveAndReimport();
        }
    }

    static (int, int, int)[] TriangleKeys(Mesh mesh, Func<int, int> key)
    {
        var indices = mesh.triangles;
        var triangles = new (int, int, int)[indices.Length / 3];
        for (int triangle = 0; triangle < triangles.Length; triangle++) {
            int offset = triangle * 3;
            int a = key(indices[offset]), b = key(indices[offset + 1]), c = key(indices[offset + 2]);
            // Normalize cyclic order while retaining winding.
            triangles[triangle] = a <= b && a <= c ? (a, b, c) : b <= c ? (b, c, a) : (c, a, b);
        }
        Array.Sort(triangles);
        return triangles;
    }

    static int[] MatchPoints(Vector3[] source, Vector3[] target, float tolerance, Vector2[] sourceUv = null, Vector2[] targetUv = null)
    {
        Vector3Int Cell(Vector3 point) => Vector3Int.FloorToInt(point / tolerance);
        var buckets = new Dictionary<Vector3Int, List<int>>();
        for (int i = 0; i < target.Length; i++) {
            var cell = Cell(target[i]);
            if (!buckets.TryGetValue(cell, out var bucket)) buckets[cell] = bucket = new List<int>();
            bucket.Add(i);
        }
        var matches = new int[source.Length];
        for (int i = 0; i < source.Length; i++) {
            var cell = Cell(source[i]);
            var best = tolerance * tolerance;
            matches[i] = -1;
            for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
                if (!buckets.TryGetValue(cell + new Vector3Int(x, y, z), out var bucket)) continue;
                foreach (var candidate in bucket) {
                    if (sourceUv != null && (sourceUv[i] - targetUv[candidate]).sqrMagnitude > 1e-12f) continue;
                    var distance = (source[i] - target[candidate]).sqrMagnitude;
                    if (distance > best) continue;
                    best = distance;
                    matches[i] = candidate;
                }
            }
        }
        return matches;
    }

    static float Delta(Vector3[] source, Vector3[] target, int[] matches)
    {
        float maximum = 0;
        for (int i = 0; i < source.Length; i++) maximum = Mathf.Max(maximum, Vector3.Distance(source[i], target[matches[i]]));
        return maximum;
    }

    static float WeightDelta(Model before, Model after, int[] matches)
    {
        var left = before.mesh.boneWeights;
        var right = after.mesh.boneWeights;
        var leftBones = before.skin.bones;
        var rightBones = after.skin.bones;
        float maximum = 0;
        for (int i = 0; i < left.Length; i++) {
            var source = Weights(left[i], leftBones);
            var target = Weights(right[matches[i]], rightBones);
            foreach (var bone in source.Keys.Union(target.Keys)) {
                source.TryGetValue(bone, out float a);
                target.TryGetValue(bone, out float b);
                maximum = Mathf.Max(maximum, Mathf.Abs(a - b));
            }
        }
        return maximum;
    }

    static Dictionary<string, float> Weights(BoneWeight weight, Transform[] bones)
    {
        var map = new Dictionary<string, float>();
        void Add(int index, float value) {
            if (value <= 0) return;
            var name = bones[index].name;
            map.TryGetValue(name, out float previous);
            map[name] = previous + value;
        }
        Add(weight.boneIndex0, weight.weight0);
        Add(weight.boneIndex1, weight.weight1);
        Add(weight.boneIndex2, weight.weight2);
        Add(weight.boneIndex3, weight.weight3);
        return map;
    }
}
