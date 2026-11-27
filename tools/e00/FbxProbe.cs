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
        if (assetPath.StartsWith("Assets/Fixtures/seams-", StringComparison.Ordinal)) importer.weldVertices = false;
        if (assetPath.StartsWith("Assets/Fixtures/adverse-", StringComparison.Ordinal)) {
            importer.skinWeights = ModelImporterSkinWeights.Custom;
            importer.maxBonesPerVertex = 8;
        }
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
        public int stitchedUvVertices;
        public float observedMove, maxUvError;
        public bool sameTriangleConnectivity;
        public int sourceUv1Vertices, exportedUv1Vertices, unmatchedAtlasVertices, atlasNormalDifferences;
        public float maxNormalError;
    }

    [Serializable] sealed class PositionEdit
    {
        public float offsetY;
        public int minimumUvCopies;
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
            var vertices = mesh.vertices;
            var localOffset = meshTransform.InverseTransformVector(worldOffset);
            foreach (int index in indices) vertices[index] += localOffset;
            SetPoseProbeVertices(vertices);
        }

        public void SetPoseProbeVertices(Vector3[] vertices)
        {
            poseMesh = UnityEngine.Object.Instantiate(mesh);
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

    public static void RunSoftSelection()
    {
        const float tolerance = 2e-5f;
        var comparisons = new List<Pair>();
        foreach (var fixture in new[] { "seams-soft-selection", "elbow-soft-selection" }) {
            var folder = "Assets/Fixtures/" + fixture;
            using (var before = new Model(Directory.GetFiles(folder + "/original", "*.fbx").Single().Replace('\\', '/')))
            using (var after = new Model(Directory.GetFiles(folder + "/exported", "*.fbx").Single().Replace('\\', '/'))) {
                var vertices = before.mesh.vertices;
                var uv = before.mesh.uv;
                var sourceIndices = before.mesh.triangles;
                var expectedVertices = (Vector3[])vertices.Clone();
                var expectedCorners = new Vector3[sourceIndices.Length];
                var delta = Vector3.up * .03125f;
                if (before.skin != null) for (int i = 0; i < uv.Length; i++) {
                    float weight = Mathf.Abs(uv[i].y - .0625f) < 1e-6f ? (uv[i].x < .5f ? 1 : .6f) :
                        (uv[i].x < .5f && Mathf.Abs(uv[i].y - .5f) < 1e-6f ? .2f : 0);
                    expectedVertices[i] += delta * weight;
                }
                for (int i = 0; i < sourceIndices.Length; i += 3) {
                    // The detached witness is the only triangle with a vertex below the cube.
                    bool detached = Enumerable.Range(i, 3).Any(j => vertices[sourceIndices[j]].y < -.5f);
                    for (int j = i; j < i + 3; j++) {
                        int k = sourceIndices[j];
                        var expected = expectedVertices[k];
                        if (before.skin == null && !detached) expected += delta * Mathf.Max(0, 1 - vertices[k].magnitude / 1.5f);
                        expectedCorners[j] = before.meshTransform.TransformPoint(expected);
                    }
                }
                var matches = MatchPoints(expectedCorners, after.basePoints, tolerance, sourceIndices.Select(i => uv[i]).ToArray(), after.mesh.uv);
                var result = new Pair { fixture = fixture, original = before.info, exported = after.info, tolerance = tolerance };
                if (matches.Any(i => i < 0)) throw new InvalidOperationException("Unexpected Soft Selection position or UV in " + fixture);
                var canonical = MatchPoints(after.basePoints, after.basePoints, tolerance, after.mesh.uv, after.mesh.uv);
                result.sameTriangleConnectivity = TriangleKeys(matches, i => canonical[i]).SequenceEqual(TriangleKeys(after.mesh, i => canonical[i]));
                result.baseError = Delta(expectedCorners, after.basePoints, matches);
                result.compatible = result.sameTriangleConnectivity && before.info.boundBaseColor == 1 && after.info.boundBaseColor == 1;
                if (before.skin != null) {
                    if (after.skin == null || !before.info.boneNames.SequenceEqual(after.info.boneNames) ||
                        !before.info.clips.SequenceEqual(after.info.clips) || before.clips.Length != 1) throw new InvalidOperationException("Lost skin or clip.");
                    var indices = MatchPoints(expectedVertices.Select(before.meshTransform.TransformPoint).ToArray(), after.basePoints, tolerance, uv, after.mesh.uv);
                    if (indices.Any(i => i < 0)) throw new InvalidOperationException("Lost a skinned point.");
                    result.maxWeightError = WeightDelta(before, after, indices);
                    before.SetPoseProbeVertices(expectedVertices);
                    result.maxClipDurationError = Mathf.Abs(before.clips[0].length - after.clips[0].length);
                    Vector3[] firstPose = null;
                    var identity = Enumerable.Range(0, indices.Length).ToArray();
                    for (int t = 0; t <= 20; t++) {
                        before.clips[0].SampleAnimation(before.root, before.clips[0].length * t / 20);
                        after.clips[0].SampleAnimation(after.root, after.clips[0].length * t / 20);
                        var pose = before.PosedPoints();
                        if (firstPose == null) firstPose = pose;
                        result.originalClipMotion = Mathf.Max(result.originalClipMotion, Delta(firstPose, pose, identity));
                        result.maxClipError = Mathf.Max(result.maxClipError, Delta(pose, after.PosedPoints(), indices));
                        result.clipSamples++;
                    }
                    result.compatible &= result.maxWeightError <= 1e-6f && result.maxClipDurationError <= 1e-5f &&
                        result.maxClipError <= tolerance && result.originalClipMotion > tolerance;
                }
                comparisons.Add(result);
            }
        }
        File.WriteAllText("soft-selection-unity.json", JsonUtility.ToJson(new Report { unityVersion = Application.unityVersion, comparisons = comparisons.ToArray() }, true));
        if (comparisons.Any(result => !result.compatible)) throw new InvalidOperationException("Soft Selection FBX comparison failed.");
    }

    static Pair Compare(string fixture, Model before, Model after, PositionEdit edit)
    {
        var atlas = fixture.EndsWith("-atlas", StringComparison.Ordinal);
        var stitch = fixture.EndsWith("-uv-stitch", StringComparison.Ordinal);
        float diagonal = Vector3.Distance(before.info.min, before.info.max);
        float tolerance = Mathf.Max(1e-6f, 1e-4f * diagonal);
        var result = new Pair { fixture = fixture, original = before.info, exported = after.info, tolerance = tolerance };
        var baseTolerance = Mathf.Max(1e-7f, 1e-5f * diagonal);
        var expected = before.basePoints;
        Vector2[] beforeUv = null, afterUv = null;
        Vector3[] beforeNormals = null, afterNormals = null;
        if (atlas || stitch) {
            beforeUv = before.mesh.uv;
            afterUv = after.mesh.uv;
            beforeNormals = before.mesh.normals;
            afterNormals = after.mesh.normals;
            if (beforeUv.Length != before.basePoints.Length || afterUv.Length != after.basePoints.Length ||
                beforeNormals.Length != before.basePoints.Length || afterNormals.Length != after.basePoints.Length) return result;
        }
        if (stitch) {
            for (int i = 0; i < beforeUv.Length; i++) {
                if (Mathf.Abs(beforeUv[i].x - .625f) > 1e-6f) continue;
                beforeUv[i].x = .375f;
                result.stitchedUvVertices++;
            }
        }
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

        var matches = MatchPoints(expected, after.basePoints, positionTolerance, beforeUv, afterUv, beforeNormals, afterNormals);
        var reverse = MatchPoints(after.basePoints, expected, baseTolerance, afterUv, beforeUv, afterNormals, beforeNormals);
        if (stitch && matches.All(i => i >= 0) && reverse.All(i => i >= 0)) {
            // Coincident render vertices can have distinct weights. Match their incident triangle corners.
            var canonical = MatchPoints(after.basePoints, after.basePoints, baseTolerance, afterUv, afterUv, afterNormals, afterNormals);
            matches = MatchStitchCorners(before.mesh.triangles, after.mesh.triangles, matches, canonical);
            if (matches.Any(i => i < 0) || matches.Distinct().Count() != reverse.Length) return result;
            for (int i = 0; i < matches.Length; i++) reverse[matches[i]] = i;
        }
        result.baseError = matches.All(index => index >= 0) ? Delta(expected, after.basePoints, matches) : -1;
        result.compatible = result.baseError >= 0 && result.baseError <= baseTolerance
            && reverse.All(index => index >= 0)
            && before.info.triangles == after.info.triangles && before.info.boneNames.SequenceEqual(after.info.boneNames)
            && before.info.bindPoses == after.info.bindPoses && before.info.boundBaseColor == after.info.boundBaseColor
            && before.info.boundNormal == after.info.boundNormal && before.info.clips.SequenceEqual(after.info.clips);
        if (atlas) {
            var atlasUv = after.mesh.uv2;
            result.sourceUv1Vertices = before.mesh.uv2.Length;
            result.exportedUv1Vertices = atlasUv.Length;
            result.unmatchedAtlasVertices = reverse.Count(index => index < 0);
            if (result.unmatchedAtlasVertices == 0) {
                result.maxUvError = Enumerable.Range(0, reverse.Length).Max(i => Vector2.Distance(afterUv[i], beforeUv[reverse[i]]));
                result.maxNormalError = Delta(afterNormals, beforeNormals, reverse);
                result.atlasNormalDifferences = Enumerable.Range(0, reverse.Length)
                    .Count(i => (afterNormals[i] - beforeNormals[reverse[i]]).sqrMagnitude > 1e-10f);
            }
            result.compatible &= result.sourceUv1Vertices == 0 && atlasUv.Length == after.mesh.vertexCount
                && after.mesh.vertexCount > before.mesh.vertexCount
                && atlasUv.All(uv => uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1);
        }
        if (edit != null && result.baseError >= 0) {
            result.observedMove = Vector3.Distance(before.basePoints[moved[0]], after.basePoints[matches[moved[0]]]);
            result.maxUvError = Enumerable.Range(0, matches.Length).Max(i => Vector2.Distance(beforeUv[i], afterUv[matches[i]]));
            var canonical = MatchPoints(after.basePoints, after.basePoints, baseTolerance, afterUv, afterUv);
            result.sameTriangleConnectivity = TriangleKeys(before.mesh, i => canonical[matches[i]])
                .SequenceEqual(TriangleKeys(after.mesh, i => canonical[i]));
            int minimumUvCopies = edit.minimumUvCopies > 0 ? edit.minimumUvCopies : 2;
            result.compatible &= result.editedUvCopies >= minimumUvCopies && result.sameTriangleConnectivity;
        }
        if (stitch && result.baseError >= 0 && reverse.All(index => index >= 0)) {
            result.maxUvError = Enumerable.Range(0, matches.Length).Max(i => Vector2.Distance(beforeUv[i], afterUv[matches[i]]));
            result.maxNormalError = Delta(beforeNormals, afterNormals, matches);
            var canonical = MatchPoints(after.basePoints, after.basePoints, baseTolerance, afterUv, afterUv, afterNormals, afterNormals);
            result.sameTriangleConnectivity = TriangleKeys(before.mesh, i => canonical[matches[i]])
                .SequenceEqual(TriangleKeys(after.mesh, i => canonical[i]));
            result.compatible &= result.stitchedUvVertices == 2 && result.sameTriangleConnectivity &&
                result.maxUvError <= 1e-6f && result.maxNormalError <= 1e-6f;
        }
        if (before.skin == null || after.skin == null || result.baseError < 0) return result;

        result.maxWeightError = WeightDelta(before, after, matches);
        if ((atlas || stitch) && reverse.All(index => index >= 0)) {
            result.maxWeightError = Mathf.Max(result.maxWeightError, WeightDelta(after, before, reverse));
        }
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

    static (int, int, int)[] TriangleKeys(Mesh mesh, Func<int, int> key) => TriangleKeys(mesh.triangles, key);

    static (int, int, int)[] TriangleKeys(int[] indices, Func<int, int> key)
    {
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

    static int[] MatchStitchCorners(int[] source, int[] target, int[] approximateMatches, int[] canonical)
    {
        var matches = Enumerable.Repeat(-1, approximateMatches.Length).ToArray();
        for (int i = 0; i < source.Length; i += 3) {
            var expected = Enumerable.Range(0, 3).Select(k => canonical[approximateMatches[source[i + k]]]).ToArray();
            for (int j = 0; j < target.Length; j += 3) for (int offset = 0; offset < 3; offset++) {
                var rotated = Enumerable.Range(0, 3).Select(k => target[j + (offset + k) % 3]).ToArray();
                if (!expected.SequenceEqual(rotated.Select(k => canonical[k]))) continue;
                for (int k = 0; k < 3; k++) matches[source[i + k]] = rotated[k];
            }
        }
        return matches;
    }

    static int[] MatchPoints(Vector3[] source, Vector3[] target, float tolerance, Vector2[] sourceUv = null, Vector2[] targetUv = null,
        Vector3[] sourceNormals = null, Vector3[] targetNormals = null)
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
            var bestNormal = 1e-6f;
            matches[i] = -1;
            for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
                if (!buckets.TryGetValue(cell + new Vector3Int(x, y, z), out var bucket)) continue;
                foreach (var candidate in bucket) {
                    if (sourceUv != null && (sourceUv[i] - targetUv[candidate]).sqrMagnitude > 1e-12f) continue;
                    var distance = (source[i] - target[candidate]).sqrMagnitude;
                    if (distance > best) continue;
                    var normal = sourceNormals == null ? 0f : (sourceNormals[i] - targetNormals[candidate]).sqrMagnitude;
                    if (normal > 1e-6f || (distance == best && normal > bestNormal)) continue;
                    best = distance;
                    bestNormal = normal;
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
