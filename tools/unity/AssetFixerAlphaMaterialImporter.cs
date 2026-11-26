using System;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

// Install in a Built-in Render Pipeline project's Assets/Editor directory.
public sealed class AssetFixerAlphaMaterialImporter : AssetPostprocessor
{
    [Serializable] internal sealed class Profile
    {
        public string alphaMode;
        public float alphaCutoff;
        public float[] uvTransform;
    }

    [Serializable] internal sealed class Manifest
    {
        public string stage, model;
        public Profile assetFixerMaterial;
    }

    public override uint GetVersion() => 1;

    void OnPostprocessMaterial(Material material)
    {
        if (!assetPath.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase) || material.shader.name != "Standard") return;
        var path = Path.Combine(Path.GetDirectoryName(assetPath), "manifest.json");
        var file = new FileInfo(path);
        if (!file.Exists || file.Length > 64 * 1024) return;
        Manifest manifest;
        try {
            manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(path));
        } catch (ArgumentException) {
            return;
        }
        var profile = manifest?.assetFixerMaterial;
        if (manifest?.stage != "E00" || manifest.model != Path.GetFileName(assetPath) || profile == null ||
            profile.uvTransform != null || !IsValid(profile)) return;
        Apply(material, profile);
    }

    static bool IsValid(Profile profile) =>
        profile.alphaMode == "blend" || (profile.alphaMode == "mask" && profile.alphaCutoff > 0 && profile.alphaCutoff < 1);

    internal static void Apply(Material material, Profile profile)
    {
        bool mask = profile.alphaMode == "mask";
        material.SetOverrideTag("RenderType", mask ? "TransparentCutout" : "Transparent");
        material.SetFloat("_Mode", mask ? 1 : 2);
        if (mask) material.SetFloat("_Cutoff", profile.alphaCutoff);
        material.SetInt("_SrcBlend", (int)(mask ? BlendMode.One : BlendMode.SrcAlpha));
        material.SetInt("_DstBlend", (int)(mask ? BlendMode.Zero : BlendMode.OneMinusSrcAlpha));
        material.SetInt("_ZWrite", mask ? 1 : 0);
        if (mask) {
            material.EnableKeyword("_ALPHATEST_ON");
            material.DisableKeyword("_ALPHABLEND_ON");
        } else {
            material.DisableKeyword("_ALPHATEST_ON");
            material.EnableKeyword("_ALPHABLEND_ON");
        }
        material.DisableKeyword("_ALPHAPREMULTIPLY_ON");
        material.renderQueue = (int)(mask ? RenderQueue.AlphaTest : RenderQueue.Transparent);
    }
}
