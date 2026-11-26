/* Independent FBX inspection for the E00 fixture pairs. */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ufbx.h"

static ufbx_scene *load(const char *path, size_t mesh_count)
{
    ufbx_error error;
    ufbx_scene *scene = ufbx_load_file(path, NULL, &error);
    if (!scene) {
        char description[1024];
        ufbx_format_error(description, sizeof(description), &error);
        fprintf(stderr, "%s: %s\n", path, description);
        exit(1);
    }
    if (scene->meshes.count != mesh_count) {
        fprintf(stderr, "Expected %zu meshes in %s.\n", mesh_count, path);
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

static double uv_distance(ufbx_vec2 a, ufbx_vec2 b)
{
    return hypot(a.x - b.x, a.y - b.y);
}

enum { seam_point = 0, coincident_point = 8, seam_variant_count = 3 };

static bool seam_witness(const ufbx_mesh *mesh, double *min_uv_gap, double *min_normal_angle)
{
    if (mesh->num_vertices != 11 || mesh->num_faces != 13 || mesh->num_indices != 39 ||
        mesh->uv_sets.count != 1 || !mesh->vertex_uv.exists || !mesh->vertex_normal.exists) return false;
    size_t variants[seam_variant_count], count = 0, target_corners = 0, witness_corner = 0, witness_corners = 0;
    for (size_t f = 0; f < mesh->num_faces; f++) {
        const ufbx_face face = mesh->faces.data[f];
        if (face.num_indices != 3) return false;
        const bool witness_face = mesh->vertex_indices.data[face.index_begin] >= coincident_point;
        for (size_t i = face.index_begin; i < face.index_begin + face.num_indices; i++) {
            const uint32_t point = mesh->vertex_indices.data[i];
            if ((point >= coincident_point) != witness_face) return false;
            if (point == coincident_point) {
                witness_corner = i;
                witness_corners++;
            }
            if (point != seam_point) continue;
            target_corners++;
            const ufbx_vec2 uv = ufbx_get_vertex_vec2(&mesh->vertex_uv, i);
            bool known = false;
            for (size_t k = 0; k < count; k++) known |= uv_distance(uv, ufbx_get_vertex_vec2(&mesh->vertex_uv, variants[k])) < 1e-9;
            if (known) continue;
            if (count == seam_variant_count) return false;
            variants[count++] = i;
        }
    }
    if (count != seam_variant_count || target_corners != 6 || witness_corners != 1) return false;
    *min_uv_gap = *min_normal_angle = INFINITY;
    bool shared_attributes = false;
    for (size_t i = 0; i < count; i++) {
        const ufbx_vec2 uv = ufbx_get_vertex_vec2(&mesh->vertex_uv, variants[i]);
        const ufbx_vec3 n = ufbx_get_vertex_vec3(&mesh->vertex_normal, variants[i]);
        shared_attributes |= uv_distance(uv, ufbx_get_vertex_vec2(&mesh->vertex_uv, witness_corner)) < 1e-9 &&
            point_distance(n, ufbx_get_vertex_vec3(&mesh->vertex_normal, witness_corner)) < 1e-9;
        for (size_t j = 0; j < i; j++) {
            *min_uv_gap = fmin(*min_uv_gap, uv_distance(uv, ufbx_get_vertex_vec2(&mesh->vertex_uv, variants[j])));
            *min_normal_angle = fmin(*min_normal_angle, normal_angle(n, ufbx_get_vertex_vec3(&mesh->vertex_normal, variants[j])));
        }
    }
    return shared_attributes && *min_uv_gap > 0.1 && fabs(*min_normal_angle - 90.0) <= 0.1;
}

static bool compare_seams(const ufbx_mesh *a, const ufbx_mesh *b, double offset_y)
{
    double source_gap, source_angle, exported_gap, exported_angle;
    if (!same_connectivity(a, b) || !seam_witness(a, &source_gap, &source_angle) ||
        !seam_witness(b, &exported_gap, &exported_angle)) return false;

    const double initial_separation = point_distance(a->vertices.data[seam_point], a->vertices.data[coincident_point]);
    const double final_separation = point_distance(b->vertices.data[seam_point], b->vertices.data[coincident_point]);
    const double coincident_move = point_distance(a->vertices.data[coincident_point], b->vertices.data[coincident_point]);
    const double observed_y = b->vertices.data[seam_point].y - a->vertices.data[seam_point].y;
    size_t changed = 0;
    double position_error = 0.0, uv_error = 0.0, normal_error = 0.0;
    for (size_t i = 0; i < a->num_vertices; i++) {
        ufbx_vec3 expected = a->vertices.data[i];
        changed += point_distance(expected, b->vertices.data[i]) > 1e-9;
        if (i == seam_point) expected.y += offset_y;
        position_error = fmax(position_error, point_distance(expected, b->vertices.data[i]));
    }
    for (size_t i = 0; i < a->num_indices; i++) {
        uv_error = fmax(uv_error, uv_distance(ufbx_get_vertex_vec2(&a->vertex_uv, i), ufbx_get_vertex_vec2(&b->vertex_uv, i)));
        normal_error = fmax(normal_error, normal_angle(ufbx_get_vertex_vec3(&a->vertex_normal, i),
                                                     ufbx_get_vertex_vec3(&b->vertex_normal, i)));
    }
    printf(",\"seams\":{\"samePolygonConnectivity\":true,\"targetControlPoint\":%d,\"coincidentControlPoint\":%d,"
           "\"changedControlPoints\":%zu,\"initialSeparation\":%.9g,\"finalSeparation\":%.9g,"
           "\"observedOffsetY\":%.9g,\"coincidentPointMovement\":%.9g,\"maxPositionError\":%.9g,"
           "\"targetUvVariants\":%d,\"minUvSeamGap\":%.9g,\"minHardNormalAngle\":%.9g,"
           "\"maxCornerUvError\":%.9g,\"maxCornerNormalAngle\":%.9g}",
           seam_point, coincident_point, changed, initial_separation, final_separation, observed_y, coincident_move,
           position_error, seam_variant_count, exported_gap, exported_angle, uv_error, normal_error);
    return initial_separation == 0.0 && changed == (offset_y != 0.0 ? 1 : 0) && coincident_move == 0.0 &&
        position_error <= 1e-9 && uv_error <= 1e-9 && normal_error <= 0.1;
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

static bool compare_repair(const ufbx_mesh *a, const ufbx_mesh *b, size_t center, bool smooth)
{
    if (center >= a->num_vertices || a->num_vertices != b->num_vertices || a->num_triangles != b->num_triangles ||
        a->uv_sets.count != 1 || b->uv_sets.count != 1 || b->num_faces != a->num_faces + (smooth ? 4 : 0)) return false;
    size_t target_face = 0, replaced = 0, uv_copies = 0;
    ufbx_vec2 center_uvs[4];
    ufbx_vec3 estimate = { 0 };
    double max_uv = 0, max_normal = 0;
    for (size_t f = 0; f < a->num_faces; f++) {
        ufbx_face face = a->faces.data[f];
        size_t center_corner = face.num_indices;
        for (size_t c = 0; c < face.num_indices; c++) {
            if (a->vertex_indices.data[face.index_begin + c] == center) center_corner = c;
        }
        const bool patch = center_corner < face.num_indices;
        if (patch) {
            if (face.num_indices != 4 || replaced++ >= 4) return false;
            ufbx_vec2 uv = ufbx_get_vertex_vec2(&a->vertex_uv, face.index_begin + center_corner);
            bool seen = false;
            for (size_t k = 0; k < uv_copies; k++) seen |= center_uvs[k].x == uv.x && center_uvs[k].y == uv.y;
            if (!seen) center_uvs[uv_copies++] = uv;
            for (size_t k = 1; k < 4; k++) {
                // A side midpoint belongs to two input quads and a corner to one.
                const double weight = smooth ? (k == 2 ? 0.125 : 0.0625) : (k == 2 ? -0.25 : 0.25);
                const ufbx_vec3 p = a->vertices.data[a->vertex_indices.data[face.index_begin + (center_corner + k) % 4]];
                estimate.x += weight * p.x;
                estimate.y += weight * p.y;
                estimate.z += weight * p.z;
            }
        }
        const bool split = patch && smooth;
        for (size_t t = 0; t < (split ? 2u : 1u); t++) {
            if (target_face >= b->num_faces) return false;
            const ufbx_face polygon = b->faces.data[target_face++];
            const size_t size = split ? 3 : face.num_indices;
            if (polygon.num_indices != size) return false;
            for (size_t c = 0; c < size; c++) {
                const size_t source_offset = split ? (center_corner + (c ? c + t : 0)) % 4 : c;
                const size_t src = face.index_begin + source_offset, dst = polygon.index_begin + c;
                if (a->vertex_indices.data[src] != b->vertex_indices.data[dst]) return false;
                const ufbx_vec2 u = ufbx_get_vertex_vec2(&a->vertex_uv, src), v = ufbx_get_vertex_vec2(&b->vertex_uv, dst);
                if (!isfinite(u.x) || !isfinite(u.y) || !isfinite(v.x) || !isfinite(v.y)) return false;
                max_uv = fmax(max_uv, hypot(u.x - v.x, u.y - v.y));
                max_normal = fmax(max_normal, normal_angle(ufbx_get_vertex_vec3(&a->vertex_normal, src),
                    ufbx_get_vertex_vec3(&b->vertex_normal, dst)));
            }
        }
    }
    double max_outer = 0;
    for (size_t i = 0; i < a->num_vertices; i++) {
        if (i != center) max_outer = fmax(max_outer, point_distance(a->vertices.data[i], b->vertices.data[i]));
    }
    const double center_error = point_distance(estimate, b->vertices.data[center]);
    const double center_move = point_distance(a->vertices.data[center], b->vertices.data[center]);
    printf(",\"repair\":{\"method\":\"%s\",\"sourceFacesReplaced\":%zu,\"centerUvCopies\":%zu,"
           "\"maxPositionDeltaOutsideCenter\":%.9g,\"centerMove\":%.9g,\"centerError\":%.9g,"
           "\"maxUvDeltaBySourceCorner\":%.9g,\"maxNormalAngleBySourceCorner\":%.9g}",
           smooth ? "smooth" : "grid", replaced, uv_copies, max_outer, center_move, center_error, max_uv, max_normal);
    return replaced == 4 && target_face == b->num_faces && center_move > 1e-5 && center_error < 1e-12 &&
        max_outer == 0 && max_uv == 0 && max_normal <= 1e-4 && same_skin_weights(a, b);
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

static ufbx_vec3 posed_point(const ufbx_scene *scene, uint32_t mesh_id, size_t index)
{
    const ufbx_mesh *mesh = scene->meshes.data[mesh_id];
    ufbx_vec3 point = mesh->skinned_position.values.data[index];
    if (mesh->skinned_is_local) point = ufbx_transform_position(&mesh->instances.data[0]->geometry_to_world, point);
    const double meters = scene->settings.unit_meters;
    return (ufbx_vec3){ .x = point.x * meters, .y = point.y * meters, .z = point.z * meters };
}

static bool compare_clips(const ufbx_scene *original, const ufbx_scene *exported,
                          const ufbx_mesh *mesh, const ufbx_mesh *target_mesh)
{
    if (original->anim_stacks.count == 0) return exported->anim_stacks.count == 0;
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
            const ufbx_vec3 anchor = posed_point(left, mesh->typed_id, 0), first_anchor = posed_point(first, mesh->typed_id, 0);
            for (size_t vertex = 0; vertex < mesh->num_vertices; vertex++) {
                const ufbx_vec3 point = posed_point(left, mesh->typed_id, vertex);
                max_error = fmax(max_error, point_distance(point, posed_point(right, target_mesh->typed_id, vertex)));
                source_deformation = fmax(source_deformation, fabs(point_distance(point, anchor) -
                    point_distance(posed_point(first, mesh->typed_id, vertex), first_anchor)));
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

static const ufbx_mesh *find_mesh(const ufbx_scene *scene, const char *name)
{
    const ufbx_node *node = ufbx_find_node(scene, name);
    return node ? node->mesh : NULL;
}

static bool shared_skeleton(const ufbx_scene *scene, const ufbx_mesh *const meshes[2])
{
    const ufbx_node *bones[] = { ufbx_find_node(scene, "Pelvis"), ufbx_find_node(scene, "Spine"), ufbx_find_node(scene, "Chest") };
    if (scene->bones.count != 3 || !bones[0] || !bones[1] || !bones[2] || bones[1]->parent != bones[0] || bones[2]->parent != bones[1]) return false;
    for (size_t i = 0; i < 2; i++) {
        const ufbx_mesh *mesh = meshes[i];
        if (!mesh || mesh->instances.count != 1 || mesh->skin_deformers.count != 1) return false;
        const ufbx_skin_cluster_list clusters = mesh->skin_deformers.data[0]->clusters;
        if (clusters.count != 3) return false;
        for (size_t j = 0; j < 3; j++) {
            bool found = false;
            for (size_t k = 0; k < clusters.count; k++) found |= clusters.data[k]->bone_node == bones[j];
            if (!bones[j]->bone || !found) return false;
        }
    }
    return true;
}

static bool compare_shared_skin(const ufbx_scene *original, const ufbx_scene *exported)
{
    const char *names[] = { "Body", "Clothing" };
    const size_t expected_vertices[] = { 40, 32 }, expected_triangles[] = { 76, 48 };
    const ufbx_mesh *source[] = { find_mesh(original, names[0]), find_mesh(original, names[1]) };
    const ufbx_mesh *output[] = { find_mesh(exported, names[0]), find_mesh(exported, names[1]) };
    const bool source_shared = shared_skeleton(original, source), output_shared = shared_skeleton(exported, output);
    printf("{\"originalSharedSkeleton\":%s,\"exportedSharedSkeleton\":%s,\"originalBoneCount\":%zu,\"exportedBoneCount\":%zu,\"meshes\":[",
           source_shared ? "true" : "false", output_shared ? "true" : "false", original->bones.count, exported->bones.count);
    bool compatible = source_shared && output_shared && original->anim_stacks.count == 1 && exported->anim_stacks.count == 1;
    if (source_shared && output_shared) {
        for (size_t i = 0; i < 2; i++) {
            const ufbx_mesh *a = source[i], *b = output[i];
            const bool topology = same_connectivity(a, b) && a->num_vertices == expected_vertices[i] && a->num_triangles == expected_triangles[i];
            const bool weights = same_skin_weights(a, b);
            const ufbx_skin_deformer *skin = a->skin_deformers.data[0];
            double base_delta = 0.0, bind_delta = 0.0;
            if (topology) {
                for (size_t v = 0; v < a->num_vertices; v++) base_delta = fmax(base_delta, point_distance(a->vertices.data[v], b->vertices.data[v]));
            }
            if (weights) {
                for (size_t c = 0; c < skin->clusters.count; c++) {
                    const ufbx_skin_cluster *left = skin->clusters.data[c], *right = b->skin_deformers.data[0]->clusters.data[c];
                    for (size_t v = 0; v < 12; v++) {
                        bind_delta = fmax(bind_delta, fabs(left->geometry_to_bone.v[v] - right->geometry_to_bone.v[v]));
                        bind_delta = fmax(bind_delta, fabs(left->bind_to_world.v[v] - right->bind_to_world.v[v]));
                    }
                }
            }
            printf("%s{\"name\":\"%s\",\"controlPoints\":%zu,\"triangles\":%zu,\"maxInfluences\":%zu,\"sameConnectivity\":%s,"
                   "\"sameRawWeights\":%s,\"maxBaseDelta\":%.9g,\"maxBindMatrixDelta\":%.9g",
                   i ? "," : "", names[i], a->num_vertices, a->num_triangles, skin->max_weights_per_vertex,
                   topology ? "true" : "false", weights ? "true" : "false", base_delta, bind_delta);
            const bool animated = topology && compare_clips(original, exported, a, b);
            compatible &= topology && weights && animated && base_delta <= 1e-9 && bind_delta <= 1e-9;
            printf("}");
        }
    }
    printf("],\"compatible\":%s}\n", compatible ? "true" : "false");
    return compatible;
}

int main(int argc, char **argv)
{
    const bool shared = argc == 4 && strcmp(argv[3], "--shared-skin") == 0;
    if (argc != 3 && argc != 5 && !shared) {
        fprintf(stderr, "Usage: inspect_fbx original.fbx exported.fbx [--shared-skin | control-point offset-y | --seams offset-y | --atlas source-corners.bin | --baked source-corners.bin | --smooth center | --grid center]\n");
        return 2;
    }
    const bool baked = argc == 5 && strcmp(argv[3], "--baked") == 0;
    const bool atlas = baked || (argc == 5 && strcmp(argv[3], "--atlas") == 0);
    const bool smooth = argc == 5 && strcmp(argv[3], "--smooth") == 0;
    const bool repair = smooth || (argc == 5 && strcmp(argv[3], "--grid") == 0);
    const bool seams = argc == 5 && strcmp(argv[3], "--seams") == 0;
    const bool edited = argc == 5 && !atlas && !repair && !seams;
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
    ufbx_scene *original = load(argv[1], shared ? 2 : 1);
    ufbx_scene *exported = load(argv[2], shared ? 2 : 1);
    if (shared) {
        const bool matches = compare_shared_skin(original, exported);
        ufbx_free_scene(exported);
        ufbx_free_scene(original);
        return matches ? 0 : 1;
    }
    printf("{\"original\":");
    stats(original);
    printf(",\"exported\":");
    stats(exported);

    const ufbx_mesh *a = original->meshes.data[0], *b = exported->meshes.data[0];
    if (seams) {
        char *end;
        const double offset = strtod(argv[4], &end);
        const bool matches = end != argv[4] && !*end && isfinite(offset) && compare_seams(a, b, offset);
        puts("}");
        ufbx_free_scene(exported);
        ufbx_free_scene(original);
        return matches ? 0 : 1;
    }
    if (atlas) {
        const bool matches = compare_atlas(a, b, argv[4], baked);
        puts("}");
        ufbx_free_scene(exported);
        ufbx_free_scene(original);
        return matches ? 0 : 1;
    }
    if (repair) {
        char *end;
        const size_t center = (size_t)strtoull(argv[4], &end, 10);
        const bool matches = argv[4][0] != '-' && end != argv[4] && !*end && compare_repair(a, b, center, smooth);
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
    const bool animation = topology && compare_clips(original, exported, a, b);
    puts("}");
    ufbx_free_scene(exported);
    ufbx_free_scene(original);
    return topology && weights && edit_matches && animation ? 0 : 1;
}
