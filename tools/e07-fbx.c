/* Verify the extracted FBX meshes without using the editor's importer. */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "ufbx.h"

static const double tolerance = 0.00002;

static double distance(ufbx_vec3 a, ufbx_vec3 b)
{
    return sqrt((a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y) + (a.z-b.z)*(a.z-b.z));
}

static ufbx_mesh *load(const char *path, size_t vertices, size_t triangles)
{
    ufbx_error error;
    ufbx_scene *scene = ufbx_load_file(path, NULL, &error);
    if (!scene) {
        char description[1024];
        ufbx_format_error(description, sizeof(description), &error);
        fprintf(stderr, "%s\n", description);
    }
    assert(scene && scene->meshes.count == 1 && scene->textures.count == 1);
    assert(fabs(scene->settings.unit_meters - 1) < tolerance);
    ufbx_mesh *mesh = scene->meshes.data[0];
    assert(mesh->num_vertices == vertices && mesh->num_triangles == triangles && mesh->instances.count == 1);
    assert(mesh->vertex_uv.exists && mesh->vertex_normal.exists);
    return mesh;
}

static ufbx_vec3 world(ufbx_mesh *mesh, size_t i)
{
    return ufbx_transform_position(&mesh->instances.data[0]->geometry_to_world, mesh->vertices.data[i]);
}

int main(int argc, char **argv)
{
    if (argc != 4) {
        fprintf(stderr, "Usage: e07-fbx batch.fbx Assembly.fbx Rebased.fbx\n");
        return 2;
    }
    ufbx_mesh *batch = load(argv[1], 72, 36);
    ufbx_mesh *assembly = load(argv[2], 12, 6);
    ufbx_mesh *rebased = load(argv[3], 4, 2);
    double max_error = 0;
    ufbx_vec3 low = world(batch, 0), high = low;
    for (size_t i = 0; i < 12; i++) {
        ufbx_vec3 point = world(batch, i);
        low.x = fmin(low.x, point.x); low.y = fmin(low.y, point.y); low.z = fmin(low.z, point.z);
        high.x = fmax(high.x, point.x); high.y = fmax(high.y, point.y); high.z = fmax(high.z, point.z);
        double closest = INFINITY;
        for (size_t j = 0; j < 12; j++) closest = fmin(closest, distance(point, world(assembly, j)));
        max_error = fmax(max_error, closest);
    }
    assert(max_error < tolerance);
    ufbx_vec3 bottom = { (high.x + low.x) * 0.5, low.y, (high.z + low.z) * 0.5 };
    double pivot_error = distance(bottom, assembly->instances.data[0]->node_to_world.cols[3]);
    assert(pivot_error < tolerance);
    ufbx_vec3 zero = { 0, 0, 0 };
    assert(distance(zero, rebased->instances.data[0]->node_to_world.cols[3]) < tolerance);
    assert(fabs(rebased->instances.data[0]->local_transform.scale.x / batch->instances.data[0]->local_transform.scale.x - 2) < tolerance);
    ufbx_vec3 center = { 0, 0, 0 };
    for (size_t i = 12; i < 16; i++) {
        ufbx_vec3 p = world(batch, i);
        center.x += p.x / 4; center.y += p.y / 4; center.z += p.z / 4;
    }
    double rotation_error = 0, cos30 = sqrt(3) / 2;
    for (size_t i = 12; i < 16; i++) {
        ufbx_vec3 p = world(batch, i);
        const double x = p.x - center.x, y = p.y - center.y;
        ufbx_vec3 rotated = { 2 * (x * cos30 - y * 0.5), 2 * (x * 0.5 + y * cos30), 2 * (p.z - center.z) };
        double closest = INFINITY;
        for (size_t j = 0; j < 4; j++) closest = fmin(closest, distance(rotated, world(rebased, j)));
        rotation_error = fmax(rotation_error, closest);
    }
    assert(rotation_error < tolerance);
    printf("{\"assemblyTriangles\":6,\"worldPositionError\":%.9g,\"bottomPivotError\":%.9g,\"rebasedRotationAndScaleError\":%.9g}\n",
           max_error, pivot_error, rotation_error);
    return 0;
}
