/* Independent FBX inspection for the single-mesh E00 fixture pairs. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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
    printf("{\"controlPoints\":%zu,\"polygons\":%zu,\"corners\":%zu,\"triangles\":%zu,\"bones\":%zu,\"maxInfluences\":%u,"
           "\"textures\":%zu,\"animationStacks\":%zu,\"axes\":[%d,%d,%d],\"metersPerUnit\":%.9g}",
           mesh->num_vertices, mesh->num_faces, mesh->num_indices, mesh->num_triangles, bones, max_influences,
           scene->textures.count, scene->anim_stacks.count, (int)axes.right, (int)axes.up,
           (int)axes.front, scene->settings.unit_meters);
}

static bool same_connectivity(const ufbx_mesh *a, const ufbx_mesh *b)
{
    if (a->num_vertices != b->num_vertices || a->num_faces != b->num_faces || a->num_indices != b->num_indices) return false;
    for (size_t i = 0; i < a->num_faces; i++) {
        const ufbx_face left = a->faces.data[i], right = b->faces.data[i];
        if (left.index_begin != right.index_begin || left.num_indices != right.num_indices) return false;
    }
    return memcmp(a->vertex_indices.data, b->vertex_indices.data, a->num_indices * sizeof(uint32_t)) == 0;
}

static bool same_skin_weights(const ufbx_mesh *a, const ufbx_mesh *b)
{
    if (a->skin_deformers.count != b->skin_deformers.count) return false;
    for (size_t i = 0; i < a->skin_deformers.count; i++) {
        const ufbx_skin_cluster_list left = a->skin_deformers.data[i]->clusters;
        const ufbx_skin_cluster_list right = b->skin_deformers.data[i]->clusters;
        if (left.count != right.count) return false;
        for (size_t j = 0; j < left.count; j++) {
            const ufbx_skin_cluster *source = left.data[j], *target = right.data[j];
            if (!source->bone_node || !target->bone_node || strcmp(source->bone_node->name.data, target->bone_node->name.data) != 0 ||
                source->num_weights != target->num_weights) return false;
            for (size_t k = 0; k < source->num_weights; k++) {
                if (source->vertices.data[k] != target->vertices.data[k] || source->weights.data[k] != target->weights.data[k]) return false;
            }
        }
    }
    return true;
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

static double point_distance(ufbx_vec3 a, ufbx_vec3 b)
{
    return length3((ufbx_vec3){ .x = a.x - b.x, .y = a.y - b.y, .z = a.z - b.z });
}

static bool compare_atlas(const ufbx_mesh *a, const ufbx_mesh *b, const char *map_path, bool primary_atlas)
{
    if (a->num_vertices != b->num_vertices || a->num_triangles != b->num_triangles ||
        b->num_faces != b->num_triangles || b->num_indices != 3 * b->num_faces ||
        a->uv_sets.count != 1 || b->uv_sets.count != 2 || !a->vertex_normal.exists || !b->vertex_normal.exists) return false;

    FILE *map = fopen(map_path, "rb");
    uint32_t *faces = malloc(a->num_indices * sizeof(*faces));
    size_t *triangles = calloc(a->num_faces, sizeof(*triangles));
    unsigned *boundary = calloc(a->num_indices, sizeof(*boundary));
    if (!map || !faces || !triangles || !boundary) {
        fprintf(stderr, "Could not open the atlas corner map or allocate probe buffers.\n");
        exit(2);
    }
    for (size_t face = 0; face < a->num_faces; face++) {
        const ufbx_face polygon = a->faces.data[face];
        for (size_t i = 0; i < polygon.num_indices; i++) faces[polygon.index_begin + i] = (uint32_t)face;
    }

    double max_position = 0.0, max_normal = 0.0, max_uv0 = 0.0;
    size_t valid_uv_triangles = 0;
    bool mapped = true;
    for (size_t i = 0; i < a->num_vertices; i++) {
        max_position = fmax(max_position, point_distance(a->vertices.data[i], b->vertices.data[i]));
    }
    const ufbx_vertex_vec2 *old_uv = &a->uv_sets.data[0].vertex_uv;
    const ufbx_vertex_vec2 *restored_uv = &b->uv_sets.data[primary_atlas ? 1 : 0].vertex_uv;
    const ufbx_vertex_vec2 *atlas_uv = &b->uv_sets.data[primary_atlas ? 0 : 1].vertex_uv;
    for (size_t i = 0; mapped && i < b->num_faces; i++) {
        const ufbx_face triangle = b->faces.data[i];
        uint32_t source[3];
        ufbx_vec2 uv[3];
        if (triangle.num_indices != 3 || triangle.index_begin != i * 3) { mapped = false; break; }
        for (size_t k = 0; k < 3; k++) {
            unsigned char bytes[4];
            if (fread(bytes, 1, sizeof(bytes), map) != sizeof(bytes)) { mapped = false; break; }
            source[k] = (uint32_t)bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
            const size_t original = source[k], target = triangle.index_begin + k;
            if (original >= a->num_indices || a->vertex_indices.data[original] != b->vertex_indices.data[target] ||
                faces[original] != faces[source[0]]) { mapped = false; break; }
            const ufbx_vec2 p = ufbx_get_vertex_vec2(old_uv, original), q = ufbx_get_vertex_vec2(restored_uv, target);
            max_uv0 = fmax(max_uv0, hypot(p.x - q.x, p.y - q.y));
            max_normal = fmax(max_normal, normal_angle(ufbx_get_vertex_vec3(&a->vertex_normal, original),
                                                      ufbx_get_vertex_vec3(&b->vertex_normal, target)));
            uv[k] = ufbx_get_vertex_vec2(atlas_uv, target);
        }
        if (!mapped) break;
        const size_t face = faces[source[0]], sides = a->faces.data[face].num_indices;
        size_t spread = 0;
        for (size_t k = 0; k < 3; k++) {
            const size_t step = (sides + source[(k + 1) % 3] - source[k]) % sides;
            if (step == 0) mapped = false;
            if (step == 1) boundary[source[k]]++;
            spread += step;
        }
        mapped &= spread == sides;
        triangles[face]++;
        const double area = (uv[1].x - uv[0].x) * (uv[2].y - uv[0].y) - (uv[1].y - uv[0].y) * (uv[2].x - uv[0].x);
        bool valid = fabs(area) > 0.0;
        for (size_t k = 0; k < 3; k++) valid &= uv[k].x >= 0 && uv[k].x <= 1 && uv[k].y >= 0 && uv[k].y <= 1;
        if (valid) valid_uv_triangles++;
    }
    for (size_t i = 0; i < a->num_faces; i++) mapped &= triangles[i] == a->faces.data[i].num_indices - 2;
    for (size_t i = 0; i < a->num_indices; i++) mapped &= boundary[i] == 1;
    mapped &= fgetc(map) == EOF;
    fclose(map);
    free(boundary);
    free(triangles);
    free(faces);

    const bool weights = same_skin_weights(a, b);
    printf(",\"atlas\":{\"layout\":\"%s\",\"sameMappedControlPointsAndPolygonBoundaries\":%s,\"sameSourceSkinWeights\":%s,"
           "\"maxPositionDeltaByControlPoint\":%.9g,\"maxUv0DeltaByCorner\":%.9g,\"maxNormalAngleByCorner\":%.9g,"
           "\"validAtlasTriangles\":%zu}", primary_atlas ? "uv0" : "uv1", mapped ? "true" : "false", weights ? "true" : "false",
           max_position, max_uv0, max_normal, valid_uv_triangles);
    return mapped && weights && max_position == 0 && max_uv0 == 0 && max_normal <= 1e-4 && valid_uv_triangles == b->num_faces;
}

static ufbx_scene *evaluate(const ufbx_scene *scene, const ufbx_anim_stack *stack, double time)
{
    ufbx_error error;
    const ufbx_evaluate_opts opts = { .evaluate_skinning = true };
    ufbx_scene *pose = ufbx_evaluate_scene(scene, stack->anim, time, &opts, &error);
    if (!pose) {
        char description[1024];
        ufbx_format_error(description, sizeof(description), &error);
        fprintf(stderr, "%s\n", description);
        exit(1);
    }
    return pose;
}

static ufbx_vec3 posed_point(const ufbx_scene *scene, size_t index)
{
    const ufbx_mesh *mesh = scene->meshes.data[0];
    ufbx_vec3 point = mesh->skinned_position.values.data[index];
    if (mesh->skinned_is_local) point = ufbx_transform_position(&mesh->instances.data[0]->geometry_to_world, point);
    const double meters = scene->settings.unit_meters;
    return (ufbx_vec3){ .x = point.x * meters, .y = point.y * meters, .z = point.z * meters };
}

static bool compare_clips(const ufbx_scene *original, const ufbx_scene *exported)
{
    if (original->anim_stacks.count == 0) return exported->anim_stacks.count == 0;
    const ufbx_mesh *mesh = original->meshes.data[0];
    const ufbx_mesh *target_mesh = exported->meshes.data[0];
    if (mesh->instances.count != 1 || target_mesh->instances.count != 1) return false;

    const ufbx_matrix *matrix = &mesh->instances.data[0]->geometry_to_world;
    ufbx_vec3 min = ufbx_transform_position(matrix, mesh->vertices.data[0]), max = min;
    for (size_t i = 1; i < mesh->num_vertices; i++) {
        const ufbx_vec3 point = ufbx_transform_position(matrix, mesh->vertices.data[i]);
        min = (ufbx_vec3){ .x = fmin(min.x, point.x), .y = fmin(min.y, point.y), .z = fmin(min.z, point.z) };
        max = (ufbx_vec3){ .x = fmax(max.x, point.x), .y = fmax(max.y, point.y), .z = fmax(max.z, point.z) };
    }
    const double tolerance = fmax(1e-6, 1e-4 * original->settings.unit_meters * point_distance(min, max));
    bool names_match = original->anim_stacks.count == exported->anim_stacks.count;
    double max_start_error = 0, max_duration_error = 0, max_error = 0, source_deformation = 0;
    size_t samples = 0;
    for (size_t i = 0; i < original->anim_stacks.count; i++) {
        const ufbx_anim_stack *a = original->anim_stacks.data[i], *b = NULL;
        for (size_t j = 0; j < exported->anim_stacks.count; j++) {
            const ufbx_anim_stack *candidate = exported->anim_stacks.data[j];
            if (strcmp(a->name.data, candidate->name.data) == 0) {
                if (b) names_match = false;
                b = candidate;
            }
        }
        if (!b) { names_match = false; continue; }
        const double duration = a->time_end - a->time_begin, target_duration = b->time_end - b->time_begin;
        max_start_error = fmax(max_start_error, fabs(a->time_begin - b->time_begin));
        max_duration_error = fmax(max_duration_error, fabs(duration - target_duration));
        ufbx_scene *first = evaluate(original, a, a->time_begin);
        for (int sample = 0; sample <= 20; sample++) {
            const double fraction = sample / 20.0;
            ufbx_scene *left = evaluate(original, a, a->time_begin + duration * fraction);
            ufbx_scene *right = evaluate(exported, b, b->time_begin + target_duration * fraction);
            const ufbx_vec3 anchor = posed_point(left, 0), first_anchor = posed_point(first, 0);
            for (size_t vertex = 0; vertex < mesh->num_vertices; vertex++) {
                const ufbx_vec3 point = posed_point(left, vertex);
                max_error = fmax(max_error, point_distance(point, posed_point(right, vertex)));
                source_deformation = fmax(source_deformation, fabs(point_distance(point, anchor) -
                    point_distance(posed_point(first, vertex), first_anchor)));
            }
            samples++;
            ufbx_free_scene(right);
            ufbx_free_scene(left);
        }
        ufbx_free_scene(first);
    }
    printf(",\"animation\":{\"sameNames\":%s,\"samples\":%zu,\"maxStartErrorSeconds\":%.9g,"
           "\"maxDurationErrorSeconds\":%.9g,\"maxDeformationErrorMeters\":%.9g,"
           "\"sourceShapeChangeMeters\":%.9g,\"deformationToleranceMeters\":%.9g}",
           names_match ? "true" : "false", samples, max_start_error, max_duration_error, max_error, source_deformation, tolerance);
    return names_match && max_start_error <= 1e-5 && max_duration_error <= 1e-5 && max_error <= tolerance && source_deformation > tolerance;
}

int main(int argc, char **argv)
{
    if (argc != 3 && argc != 5) {
        fprintf(stderr, "Usage: inspect_fbx original.fbx exported.fbx [control-point offset-y | --atlas source-corners.bin | --baked source-corners.bin]\n");
        return 2;
    }
    const bool baked = argc == 5 && strcmp(argv[3], "--baked") == 0;
    const bool atlas = baked || (argc == 5 && strcmp(argv[3], "--atlas") == 0);
    const bool edited = argc == 5 && !atlas;
    unsigned long long control_point = 0;
    double offset_y = 0.0;
    if (edited) {
        char *end_index, *end_offset;
        control_point = strtoull(argv[3], &end_index, 10);
        offset_y = strtod(argv[4], &end_offset);
        if (argv[3][0] == '-' || end_index == argv[3] || *end_index || end_offset == argv[4] || *end_offset || !isfinite(offset_y) || offset_y == 0.0) {
            fprintf(stderr, "Expected a nonnegative control point index and a finite nonzero Y offset.\n");
            return 2;
        }
    }
    ufbx_scene *original = load(argv[1]);
    ufbx_scene *exported = load(argv[2]);
    printf("{\"original\":");
    stats(original);
    printf(",\"exported\":");
    stats(exported);

    const ufbx_mesh *a = original->meshes.data[0], *b = exported->meshes.data[0];
    if (atlas) {
        const bool matches = compare_atlas(a, b, argv[4], baked);
        puts("}");
        ufbx_free_scene(exported);
        ufbx_free_scene(original);
        return matches ? 0 : 1;
    }
    const bool topology = same_connectivity(a, b);
    const bool weights = same_skin_weights(a, b);
    bool edit_matches = !edited;
    printf(",\"samePolygonConnectivity\":%s,\"sameSourceSkinWeights\":%s", topology ? "true" : "false", weights ? "true" : "false");
    if (topology) {
        double position = 0.0, uv = 0.0, normal = 0.0, position_error = 0.0;
        size_t changed = 0, corner_uses = 0;
        ufbx_vec3 observed = { .x = 0, .y = 0, .z = 0 };
        bool same_uv_sets = a->uv_sets.count == b->uv_sets.count;
        const bool has_normal = a->vertex_normal.exists && b->vertex_normal.exists;
        for (size_t i = 0; i < a->num_vertices; i++) {
            const ufbx_vec3 p = a->vertices.data[i], q = b->vertices.data[i];
            ufbx_vec3 delta = { .x = q.x - p.x, .y = q.y - p.y, .z = q.z - p.z };
            position = fmax(position, length3(delta));
            if (length3(delta) > 1e-12) changed++;
            if (edited && i == control_point) {
                observed = delta;
                delta.y -= offset_y;
            }
            position_error = fmax(position_error, length3(delta));
        }
        for (size_t set = 0; same_uv_sets && set < a->uv_sets.count; set++) {
            const ufbx_vertex_vec2 *left = &a->uv_sets.data[set].vertex_uv, *right = &b->uv_sets.data[set].vertex_uv;
            same_uv_sets = left->exists == right->exists;
            if (!same_uv_sets || !left->exists) continue;
            for (size_t i = 0; i < a->num_indices; i++) {
                const ufbx_vec2 s = ufbx_get_vertex_vec2(left, i), t = ufbx_get_vertex_vec2(right, i);
                uv = fmax(uv, hypot(s.x - t.x, s.y - t.y));
            }
        }
        for (size_t i = 0; i < a->num_indices; i++) {
            if (edited && a->vertex_indices.data[i] == control_point) corner_uses++;
            if (has_normal) {
                normal = fmax(normal, normal_angle(ufbx_get_vertex_vec3(&a->vertex_normal, i),
                                                   ufbx_get_vertex_vec3(&b->vertex_normal, i)));
            }
        }
        printf(",\"maxPositionDeltaByControlPoint\":%.9g", position);
        if (same_uv_sets && a->uv_sets.count) printf(",\"maxUvDeltaInCornerOrder\":%.9g", uv);
        if (has_normal) printf(",\"maxNormalAngleInCornerOrder\":%.9g", normal);
        if (edited) {
            edit_matches = corner_uses > 1 && changed == 1 && position_error <= 1e-9 && same_uv_sets && a->uv_sets.count && uv <= 1e-9;
            printf(",\"positionEdit\":{\"controlPoint\":%llu,\"offsetY\":%.9g,\"observedOffset\":[%.9g,%.9g,%.9g],"
                   "\"affectedCorners\":%zu,\"changedControlPoints\":%zu,\"maxPositionError\":%.9g,\"matches\":%s}",
                   control_point, offset_y, observed.x, observed.y, observed.z, corner_uses, changed, position_error,
                   edit_matches ? "true" : "false");
        }
    }
    const bool animation = topology && compare_clips(original, exported);
    puts("}");
    ufbx_free_scene(exported);
    ufbx_free_scene(original);
    return topology && weights && edit_matches && animation ? 0 : 1;
}
