/* Independent FBX inspection for the single-mesh E00 fixture pairs. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include "ufbx.h"

static ufbx_scene *load(const char *path)
{
    ufbx_error error;
    ufbx_scene *scene = ufbx_load_file(path, NULL, &error);
    if (!scene) {
        char description[1024];
        ufbx_format_error(description, sizeof(description), &error);
        fprintf(stderr, "%s: %s\n", path, description);
        exit(1);
    }
    if (scene->meshes.count != 1) {
        fprintf(stderr, "Expected one mesh in %s.\n", path);
        ufbx_free_scene(scene);
        exit(1);
    }
    return scene;
}

static void stats(const ufbx_scene *scene)
{
    const ufbx_mesh *mesh = scene->meshes.data[0];
    size_t bones = 0;
    unsigned max_influences = 0;
    if (mesh->skin_deformers.count) {
        const ufbx_skin_deformer *skin = mesh->skin_deformers.data[0];
        bones = skin->clusters.count;
        for (size_t i = 0; i < skin->vertices.count; i++) {
            unsigned influences = skin->vertices.data[i].num_weights;
            if (influences > max_influences) max_influences = influences;
        }
    }
    const ufbx_coordinate_axes axes = scene->settings.axes;
    printf("{\"controlPoints\":%zu,\"triangles\":%zu,\"bones\":%zu,\"maxInfluences\":%u,"
           "\"textures\":%zu,\"animationStacks\":%zu,\"axes\":[%d,%d,%d],\"metersPerUnit\":%.9g}",
           mesh->num_vertices, mesh->num_triangles, bones, max_influences,
           scene->textures.count, scene->anim_stacks.count, (int)axes.right, (int)axes.up,
           (int)axes.front, scene->settings.unit_meters);
}

static double length3(ufbx_vec3 v)
{
    return sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

static double normal_angle(ufbx_vec3 a, ufbx_vec3 b)
{
    const double length = length3(a) * length3(b);
    if (length == 0.0) return a.x == b.x && a.y == b.y && a.z == b.z ? 0.0 : 180.0;
    const double cosine = (a.x * b.x + a.y * b.y + a.z * b.z) / length;
    return acos(fmax(-1.0, fmin(1.0, cosine))) * (180.0 / acos(-1.0));
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        fprintf(stderr, "Usage: inspect_fbx original.fbx exported.fbx\n");
        return 2;
    }
    ufbx_scene *original = load(argv[1]);
    ufbx_scene *exported = load(argv[2]);
    printf("{\"original\":");
    stats(original);
    printf(",\"exported\":");
    stats(exported);

    const ufbx_mesh *a = original->meshes.data[0], *b = exported->meshes.data[0];
    if (a->num_indices == b->num_indices) {
        double position = 0.0, uv = 0.0, normal = 0.0;
        const bool has_uv = a->vertex_uv.exists && b->vertex_uv.exists;
        const bool has_normal = a->vertex_normal.exists && b->vertex_normal.exists;
        for (size_t i = 0; i < a->num_indices; i++) {
            const ufbx_vec3 p = ufbx_get_vertex_vec3(&a->vertex_position, i);
            const ufbx_vec3 q = ufbx_get_vertex_vec3(&b->vertex_position, i);
            ufbx_vec3 delta = { .x = p.x - q.x, .y = p.y - q.y, .z = p.z - q.z };
            position = fmax(position, length3(delta));
            if (has_uv) {
                const ufbx_vec2 s = ufbx_get_vertex_vec2(&a->vertex_uv, i);
                const ufbx_vec2 t = ufbx_get_vertex_vec2(&b->vertex_uv, i);
                uv = fmax(uv, hypot(s.x - t.x, s.y - t.y));
            }
            if (has_normal) {
                normal = fmax(normal, normal_angle(ufbx_get_vertex_vec3(&a->vertex_normal, i),
                                                   ufbx_get_vertex_vec3(&b->vertex_normal, i)));
            }
        }
        printf(",\"maxPositionDeltaInCornerOrder\":%.9g", position);
        if (has_uv) printf(",\"maxUvDeltaInCornerOrder\":%.9g", uv);
        if (has_normal) printf(",\"maxNormalAngleInCornerOrder\":%.9g", normal);
    }
    puts("}");
    ufbx_free_scene(exported);
    ufbx_free_scene(original);
    return 0;
}
