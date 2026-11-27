using System;
using System.IO;
using System.Linq;
using UnityEngine;

public static class E06Probe
{
    [Serializable] sealed class GeometryReport { public Geometry[] comparisons; }
    [Serializable] sealed class Geometry { public string fixture; public bool compatible; public float originalMotion; }

    public static void Run()
    {
        Exception errors = null;
        foreach (Action probe in new Action[] { FbxProbe.Run, NormalBakeProbe.Run, TextureBakeProbe.RunPreservingPaint }) {
            try {
                probe();
            } catch (Exception error) {
                Debug.LogException(error);
                errors = errors == null ? error : new AggregateException(errors, error);
            }
        }
        if (errors != null) throw errors;
        if (!File.Exists("e00-report.json") || !File.Exists("normal-report.json") || !File.Exists("rebake-report.json"))
            throw new InvalidOperationException("An E06 probe did not write its report.");
        var rows = JsonUtility.FromJson<GeometryReport>(File.ReadAllText("e00-report.json")).comparisons;
        if (rows.Length != 3 || rows.Any(row => !row.compatible) || !rows.Any(row => row.fixture == "skinned" && row.originalMotion > 0))
            throw new InvalidOperationException("The FBX geometry or rig changed after the UV transfer.");
    }
}
