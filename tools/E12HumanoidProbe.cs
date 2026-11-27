using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

public sealed class E12HumanoidImporter : AssetPostprocessor
{
    public static readonly (HumanBodyBones role, string name)[] Mapping = {
        (HumanBodyBones.Hips, "Hips"), (HumanBodyBones.Spine, "Spine"), (HumanBodyBones.Chest, "Chest"),
        (HumanBodyBones.Neck, "Neck"), (HumanBodyBones.Head, "Head"),
        (HumanBodyBones.LeftUpperArm, "LeftUpperArm"), (HumanBodyBones.RightUpperArm, "RightUpperArm"),
        (HumanBodyBones.LeftLowerArm, "LeftForearm"), (HumanBodyBones.RightLowerArm, "RightForearm"),
        (HumanBodyBones.LeftHand, "LeftHand"), (HumanBodyBones.RightHand, "RightHand"),
        (HumanBodyBones.LeftUpperLeg, "LeftThigh"), (HumanBodyBones.RightUpperLeg, "RightThigh"),
        (HumanBodyBones.LeftLowerLeg, "LeftShin"), (HumanBodyBones.RightLowerLeg, "RightShin"),
        (HumanBodyBones.LeftFoot, "LeftFoot"), (HumanBodyBones.RightFoot, "RightFoot"),
    };

    void OnPreprocessModel()
    {
        if (!assetPath.StartsWith("Assets/Fixtures/")) return;
        var importer = (ModelImporter)assetImporter;
        importer.animationType = ModelImporterAnimationType.Human;
        importer.avatarSetup = ModelImporterAvatarSetup.CreateFromThisModel;
        importer.meshCompression = ModelImporterMeshCompression.Off;
        importer.animationCompression = ModelImporterAnimationCompression.Off;
        importer.optimizeGameObjects = false;
        importer.optimizeMeshVertices = false;
        importer.optimizeMeshPolygons = false;
        importer.skinWeights = ModelImporterSkinWeights.Standard;
        importer.importNormals = ModelImporterNormals.Import;
        importer.importTangents = ModelImporterTangents.CalculateMikk;
    }

    public static void ApplyMapping(ModelImporter importer)
    {
        // A first import populates the source skeleton and its reference transforms.
        var description = importer.humanDescription;
        description.human = Mapping.Select(pair => new HumanBone {
            humanName = HumanTrait.BoneName[(int)pair.role], boneName = pair.name,
            limit = new HumanLimit { useDefaultValues = true },
        }).ToArray();
        importer.humanDescription = description;
        importer.SaveAndReimport();
    }
}

public static class E12HumanoidProbe
{
    [Serializable] sealed class Check
    {
        public string model;
        public string[] mappingDifferences;
        public bool validAvatar, human, mappedBones, humanClips;
        public int clips, boneCount, meshVertices, samples;
        public float squatDeformation, waveDeformation, walkDeformation, sourceDeformation;
    }

    [Serializable] sealed class Report
    {
        public string unityVersion;
        public bool passed;
        public Check source, exported;
    }

    public static void Run()
    {
        var report = new Report { unityVersion = Application.unityVersion, source = Inspect("source"), exported = Inspect("exported") };
        var a = report.source;
        var b = report.exported;
        report.passed = a.validAvatar && b.validAvatar && a.human && b.human && a.mappedBones && b.mappedBones &&
            a.humanClips && b.humanClips && a.clips == 1 && b.clips == 11 && a.boneCount == b.boneCount &&
            a.meshVertices == b.meshVertices && a.sourceDeformation > .005f && b.sourceDeformation > .005f &&
            b.squatDeformation > .05f && b.waveDeformation > .05f && b.walkDeformation > .05f;
        File.WriteAllText("e12-humanoid.json", JsonUtility.ToJson(report, true));
        if (!report.passed) throw new InvalidOperationException("Unity Humanoid acceptance failed. See e12-humanoid.json.");
    }

    static Check Inspect(string name)
    {
        var path = Directory.GetFiles($"Assets/Fixtures/{name}", "*.fbx", SearchOption.AllDirectories).Single().Replace('\\', '/');
        E12HumanoidImporter.ApplyMapping((ModelImporter)AssetImporter.GetAtPath(path));
        var assets = AssetDatabase.LoadAllAssetsAtPath(path);
        var avatar = assets.OfType<Avatar>().SingleOrDefault();
        var clips = assets.OfType<AnimationClip>().Where(clip => !clip.name.StartsWith("__preview__", StringComparison.Ordinal))
            .ToDictionary(clip => clip.name);
        var check = new Check { model = name, clips = clips.Count, validAvatar = avatar != null && avatar.isValid,
            human = avatar != null && avatar.isHuman, humanClips = clips.Count > 0 && clips.Values.All(clip => clip.humanMotion) };
        if (!check.validAvatar || !check.human) return check;
        var root = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(path));
        try {
            var animator = root.GetComponent<Animator>();
            var skin = root.GetComponentInChildren<SkinnedMeshRenderer>();
            animator.avatar = avatar;
            animator.applyRootMotion = false;
            animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            animator.Rebind();
            check.mappingDifferences = E12HumanoidImporter.Mapping
                .Select(pair => (pair.role, pair.name, actual: animator.GetBoneTransform(pair.role)?.name))
                .Where(pair => pair.name != pair.actual).Select(pair => $"{pair.role}: {pair.name} / {pair.actual ?? "unmapped"}").ToArray();
            check.mappedBones = check.mappingDifferences.Length == 0;
            check.boneCount = skin.bones.Length;
            check.meshVertices = skin.sharedMesh.vertexCount;
            check.sourceDeformation = Sample("SourceStep");
            check.squatDeformation = Sample("Diagnostic_squat");
            check.waveDeformation = Sample("Diagnostic_wave");
            check.walkDeformation = Sample("Diagnostic_walk");
            return check;

            float Sample(string key)
            {
                if (!clips.TryGetValue(key, out var clip)) return 0;
                animator.Rebind();
                check.samples += 21;
                return Displacement(animator, skin, clip);
            }
        } finally {
            UnityEngine.Object.DestroyImmediate(root);
        }
    }

    static float Displacement(Animator animator, SkinnedMeshRenderer skin, AnimationClip clip)
    {
        var graph = PlayableGraph.Create(clip.name);
        var mesh = new Mesh();
        try {
            graph.SetTimeUpdateMode(DirectorUpdateMode.Manual);
            var playable = AnimationClipPlayable.Create(graph, clip);
            playable.SetSpeed(0);
            var output = AnimationPlayableOutput.Create(graph, clip.name, animator);
            output.SetSourcePlayable(playable);
            graph.Play();
            Vector3[] first = null;
            float maximum = 0;
            for (int frame = 0; frame <= 20; frame++) {
                playable.SetTime(clip.length * frame / 20.0);
                graph.Evaluate(0);
                skin.BakeMesh(mesh);
                var vertices = mesh.vertices;
                if (first == null) first = vertices;
                for (int i = 0; i < vertices.Length; i++) maximum = Mathf.Max(maximum, (vertices[i] - first[i]).magnitude);
            }
            return maximum;
        } finally {
            graph.Destroy();
            UnityEngine.Object.DestroyImmediate(mesh);
        }
    }
}
