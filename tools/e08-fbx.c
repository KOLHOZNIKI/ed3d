/* Verify that the FBX repair keeps its surrounding control points and corner data. */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "ufbx.h"

static ufbx_scene *load(const char *path)
{
    ufbx_error error;
    ufbx_scene *scene = ufbx_load_file(path, NULL, &error);
    if (!scene) {
        char description[1024];
        ufbx_format_error(description, sizeof(description), &error);
        fprintf(stderr, "%s\n", description);
    }
    assert(scene && scene->meshes.count == 1 && scene->textures.count == 1);
    return scene;
}

static int close3(ufbx_vec3 a, ufbx_vec3 b)
{
    return fabs(a.x-b.x) < 1e-7 && fabs(a.y-b.y) < 1e-7 && fabs(a.z-b.z) < 1e-7;
}

static double max_normal_degrees;

static void normal_match(ufbx_vec3 a, ufbx_vec3 b)
{
    const double x = a.y*b.z - a.z*b.y, y = a.z*b.x - a.x*b.z, z = a.x*b.y - a.y*b.x;
    const double dot = a.x*b.x + a.y*b.y + a.z*b.z;
    const double degrees = atan2(sqrt(x*x + y*y + z*z), dot) * 180.0 / acos(-1.0);
    if (dot == 0) assert(close3(a, b));
    else assert(degrees < 1e-4);
    max_normal_degrees = fmax(max_normal_degrees, degrees);
}

static void face_match(const ufbx_mesh *a, size_t ai, const ufbx_mesh *b, size_t bi, int check_uv)
{
    ufbx_face fa = a->faces.data[ai], fb = b->faces.data[bi];
    assert(fa.num_indices == fb.num_indices);
    for (size_t i = 0; i < fa.num_indices; i++) {
        size_t x = fa.index_begin + i, y = fb.index_begin + i;
        assert(close3(ufbx_get_vertex_vec3(&a->vertex_position, x), ufbx_get_vertex_vec3(&b->vertex_position, y)));
        normal_match(ufbx_get_vertex_vec3(&a->vertex_normal, x), ufbx_get_vertex_vec3(&b->vertex_normal, y));
        if (check_uv) {
            ufbx_vec2 u = ufbx_get_vertex_vec2(&a->vertex_uv, x), v = ufbx_get_vertex_vec2(&b->vertex_uv, y);
            assert(fabs(u.x-v.x) < 1e-7 && fabs(u.y-v.y) < 1e-7);
        }
    }
}

static void compare_surrounding(const ufbx_mesh *before, const ufbx_mesh *grid, const ufbx_mesh *smooth,
                                const size_t removed[4])
{
    size_t j = 0;
    for (size_t i = 0; i < before->num_faces; i++) {
        if (i == removed[0] || i == removed[1] || i == removed[2] || i == removed[3]) continue;
        face_match(before, i, grid, j, 1);
        face_match(before, i, smooth, j, 1);
        j++;
    }
    for (size_t i = j; i < j + 4; i++) assert(grid->faces.data[i].num_indices == 4);
}

static double weight(const ufbx_skin_deformer *skin, size_t control_point, size_t cluster)
{
    ufbx_skin_vertex v = skin->vertices.data[control_point];
    for (size_t i = 0; i < v.num_weights; i++) {
        ufbx_skin_weight w = skin->weights.data[v.weight_begin + i];
        if (w.cluster_index == cluster) return w.weight;
    }
    return 0;
}

static void verify_skin(const char *before, const char *after)
{
    ufbx_scene *a = load(before), *b = load(after);
    const ufbx_mesh *source = a->meshes.data[0], *mesh = b->meshes.data[0];
    assert(source->skin_deformers.count == 1 && mesh->skin_deformers.count == 1);
    assert(a->anim_stacks.count == b->anim_stacks.count && a->anim_stacks.count == 1);
    const ufbx_skin_deformer *old_skin = source->skin_deformers.data[0], *skin = mesh->skin_deformers.data[0];
    assert(old_skin->clusters.count == 2 && skin->clusters.count == 2);
    size_t found = 0, added = 0;
    for (size_t i = 0; i < mesh->num_vertices; i++) {
        size_t j = 0;
        while (j < source->num_vertices && !close3(mesh->vertices.data[i], source->vertices.data[j])) j++;
        if (j < source->num_vertices) {
            for (size_t k = 0; k < 2; k++) assert(fabs(weight(skin, i, k) - weight(old_skin, j, k)) < 1e-7);
            found++;
        } else {
            assert(fabs(weight(skin, i, 0) + weight(skin, i, 1) - 1) < 1e-7);
            added++;
        }
    }
    assert(found == source->num_vertices && added > 0 && mesh->num_triangles > source->num_triangles);
    printf("{\"originalWeightedPointsUnchanged\":%zu,\"newNormalizedPoints\":%zu,\"clips\":1}\n", found, added);
    ufbx_free_scene(a);
    ufbx_free_scene(b);
}

int main(int argc, char **argv)
{
    if (argc == 4 && strcmp(argv[1], "--skin") == 0) { verify_skin(argv[2], argv[3]); return 0; }
    if (argc != 5) {
        fprintf(stderr, "Usage: e08-fbx source.fbx grid.fbx smooth.fbx projected.fbx | --plate source.fbx grid.fbx smooth.fbx | --skin source.fbx smooth.fbx\n");
        return 2;
    }
    if (strcmp(argv[1], "--plate") == 0) {
        ufbx_scene *a = load(argv[2]), *b = load(argv[3]), *c = load(argv[4]);
        const ufbx_mesh *before = a->meshes.data[0], *grid = b->meshes.data[0], *smooth = c->meshes.data[0];
        const size_t removed[] = { 1407, 1409, 1448, 1452 };
        assert(before->num_triangles == 9138 && grid->num_triangles == 9138 && smooth->num_triangles > 9138);
        compare_surrounding(before, grid, smooth, removed);
        printf("{\"tripoUnchangedPolygons\":%zu,\"gridTriangles\":%zu,\"smoothTriangles\":%zu,\"maxCornerNormalDegrees\":%.9g}\n",
               before->num_faces - 4, grid->num_triangles, smooth->num_triangles, max_normal_degrees);
        ufbx_free_scene(a); ufbx_free_scene(b); ufbx_free_scene(c);
        return 0;
    }
    ufbx_scene *scenes[4];
    for (size_t i = 0; i < 4; i++) scenes[i] = load(argv[i + 1]);
    const ufbx_mesh *source = scenes[0]->meshes.data[0], *grid = scenes[1]->meshes.data[0];
    const ufbx_mesh *smooth = scenes[2]->meshes.data[0], *projected = scenes[3]->meshes.data[0];
    assert(source->num_faces == 16 && grid->num_faces == 16 && smooth->num_faces > 16);
    const size_t removed[] = { 5, 6, 9, 10 };
    compare_surrounding(source, grid, smooth, removed);
    assert(smooth->num_vertices == projected->num_vertices && smooth->num_triangles == projected->num_triangles);
    for (size_t i = 0; i < smooth->num_vertices; i++) assert(close3(smooth->vertices.data[i], projected->vertices.data[i]));
    for (size_t i = 0; i < projected->num_indices; i++) {
        ufbx_vec2 uv = ufbx_get_vertex_vec2(&projected->vertex_uv, i);
        assert(uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1);
    }
    printf("{\"unchangedSourcePolygons\":12,\"gridQuads\":4,\"smoothTriangles\":%zu,\"projectionPreservedControlPoints\":%zu}\n",
           smooth->num_triangles, smooth->num_vertices);
    for (size_t i = 0; i < 4; i++) ufbx_free_scene(scenes[i]);
    return 0;
}
