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
        public float maxClipError, originalClipMotion;
        public int clipSamples;
        public string testedBone;
        public bool originalHumanoidAvatar, exportedHumanoidAvatar;
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

        Vector3[] WorldPoints(Mesh source) => source.vertices.Select(meshTransform.TransformPoint).ToArray();
        public void Dispose() => UnityEngine.Object.DestroyImmediate(root);
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
            Pair comparison;
            using (var original = new Model(input))
            using (var exported = new Model(output)) {
                comparison = Compare(Path.GetFileName(fixture), original, exported);
            }
            if (comparison.fixture == "skinned") {
                comparison.originalHumanoidAvatar = HasHumanoidAvatar(input);
                comparison.exportedHumanoidAvatar = HasHumanoidAvatar(output);
            }
            comparisons.Add(comparison);
        }
        var report = new Report { unityVersion = Application.unityVersion, comparisons = comparisons.ToArray() };
        File.WriteAllText("e00-report.json", JsonUtility.ToJson(report, true));
        Debug.Log($"E00 measured {comparisons.Count} FBX pairs. See e00-report.json.");
    }

    static Pair Compare(string fixture, Model before, Model after)
    {
        float diagonal = Vector3.Distance(before.info.min, before.info.max);
        float tolerance = Mathf.Max(1e-6f, 1e-4f * diagonal);
        var result = new Pair { fixture = fixture, original = before.info, exported = after.info, tolerance = tolerance };
        var matches = MatchPoints(before.basePoints, after.basePoints, tolerance);
        result.baseError = matches.All(index => index >= 0) ? Delta(before.basePoints, after.basePoints, matches) : -1;
        var baseTolerance = Mathf.Max(1e-7f, 1e-5f * diagonal);
        result.compatible = result.baseError >= 0 && result.baseError <= baseTolerance
            && MatchPoints(after.basePoints, before.basePoints, baseTolerance).All(index => index >= 0)
            && before.info.triangles == after.info.triangles && before.info.boneNames.SequenceEqual(after.info.boneNames)
            && before.info.bindPoses == after.info.bindPoses && before.info.boundBaseColor == after.info.boundBaseColor
            && before.info.boundNormal == after.info.boundNormal && before.info.clips.SequenceEqual(after.info.clips);
        if (before.skin == null || after.skin == null || result.baseError < 0) return result;

        result.maxWeightError = WeightDelta(before, after, matches);
        result.restError = Delta(before.PosedPoints(), after.PosedPoints(), matches);
        var joint = before.skin.bones.FirstOrDefault(bone => bone.name == "Left_LowerArm" || bone.name == "Hinge");
        if (joint == null) throw new InvalidOperationException($"No designated probe joint for {fixture}.");
        var target = after.skin.bones.FirstOrDefault(bone => bone.name == joint.name);
        if (target == null) { result.compatible = false; return result; }
        result.testedBone = joint.name;
        var rest = before.PosedPoints();
        var originalRotation = joint.localRotation;
        var exportedRotation = target.localRotation;
        var identity = Enumerable.Range(0, rest.Length).ToArray();
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
        result.compatible &= result.maxWeightError <= 1e-5f && result.restError <= tolerance && result.maxPoseError <= tolerance
            && result.originalMotion > tolerance;

        for (int clip = 0; clip < Math.Min(before.clips.Length, after.clips.Length); clip++) {
            var sourceClip = before.clips[clip];
            var outputClip = after.clips[clip];
            result.compatible &= Mathf.Abs(sourceClip.length - outputClip.length) <= 1e-5f;
            for (int sample = 0; sample <= 20; sample++) {
                sourceClip.SampleAnimation(before.root, sourceClip.length * sample / 20f);
                outputClip.SampleAnimation(after.root, outputClip.length * sample / 20f);
                var pose = before.PosedPoints();
                result.maxClipError = Mathf.Max(result.maxClipError, Delta(pose, after.PosedPoints(), matches));
                result.originalClipMotion = Mathf.Max(result.originalClipMotion, Delta(rest, pose, identity));
                result.clipSamples++;
            }
        }
        result.compatible &= result.maxClipError <= tolerance && (result.clipSamples == 0 || result.originalClipMotion > tolerance);
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

    static int[] MatchPoints(Vector3[] source, Vector3[] target, float tolerance)
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
