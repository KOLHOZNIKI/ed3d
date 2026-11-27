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

static bool compare_stitched_uv(const ufbx_mesh *a, const ufbx_mesh *b)
{
    if (a->num_vertices != 8 || a->num_indices != 12 || a->uv_sets.count != 1 || b->uv_sets.count != 1 ||
        !a->vertex_uv.exists || !b->vertex_uv.exists || !a->vertex_normal.exists || !b->vertex_normal.exists) return false;
    if (point_distance(a->vertices.data[1], a->vertices.data[5]) != 0.0) return false;
    size_t changed = 0;
    double position = 0.0, uv = 0.0, normal = 0.0;
    for (size_t i = 0; i < a->num_vertices; i++) {
        position = fmax(position, point_distance(a->vertices.data[i], b->vertices.data[i]));
    }
    for (size_t i = 0; i < a->num_indices; i++) {
        const size_t expected = i == 3 ? 1 : (i == 5 || i == 8 ? 2 : i);
        const ufbx_vec2 source = ufbx_get_vertex_vec2(&a->vertex_uv, i), actual = ufbx_get_vertex_vec2(&b->vertex_uv, i);
        if (uv_distance(source, actual) > 1e-9) changed++;
        uv = fmax(uv, uv_distance(ufbx_get_vertex_vec2(&a->vertex_uv, expected), actual));
        normal = fmax(normal, normal_angle(ufbx_get_vertex_vec3(&a->vertex_normal, i),
                                           ufbx_get_vertex_vec3(&b->vertex_normal, i)));
    }
    printf(",\"uvStitch\":{\"changedCorners\":%zu,\"expectedUvError\":%.9g,\"positionError\":%.9g,\"normalAngleDegrees\":%.9g}",
           changed, uv, position, normal);
    return changed == 3 && position <= 1e-9 && uv <= 1e-9 && normal <= 1e-4;
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

static bool inspect_coordinate_source(const ufbx_scene *source)
{
    const ufbx_node *panel = ufbx_find_node(source, "Panel");
    if (!panel || !panel->parent || !panel->parent->parent ||
        strcmp(panel->parent->name.data, "Intermediate") || strcmp(panel->parent->parent->name.data, "SurveyRoot") ||
        source->anim_stacks.count != 1) return false;
    const ufbx_anim_stack *clip = source->anim_stacks.data[0];
    if (strcmp(clip->name.data, "ReferenceLift") || fabs(clip->time_begin) > 1e-6 || fabs(clip->time_end - 1.0) > 1e-6) return false;
    ufbx_vec3 centers[3];
    for (size_t i = 0; i < 3; i++) {
        ufbx_scene *pose = evaluate(source, clip, (double)i * 0.5);
        centers[i] = ufbx_find_node(pose, "Panel")->node_to_world.cols[3];
        ufbx_free_scene(pose);
    }
    const double displacement = point_distance(centers[0], centers[1]) * source->settings.unit_meters;
    const ufbx_coordinate_axes axes = source->settings.axes;
    printf("{\"axes\":[%d,%d,%d],\"metersPerUnit\":%.9g,\"clipSeconds\":%.9g,\"midpointDisplacementMeters\":%.9g}\n",
           (int)axes.right, (int)axes.up, (int)axes.front, source->settings.unit_meters, clip->time_end, displacement);
    return axes.up == UFBX_COORDINATE_AXIS_POSITIVE_Z && fabs(source->settings.unit_meters - 0.0254) < 1e-8 &&
        fabs(displacement - 0.00635) < 1e-6 && point_distance(centers[0], centers[2]) < 1e-6;
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

static bool shared_skeleton(const ufbx_scene *scene, const ufbx_mesh *const *meshes, size_t count)
{
    const ufbx_node *bones[] = { ufbx_find_node(scene, "Pelvis"), ufbx_find_node(scene, "Spine"), ufbx_find_node(scene, "Chest") };
    if (scene->bones.count != 3 || !bones[0] || !bones[1] || !bones[2] || bones[1]->parent != bones[0] || bones[2]->parent != bones[1]) return false;
    for (size_t i = 0; i < count; i++) {
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

static bool compare_shared_skin(const ufbx_scene *original, const ufbx_scene *exported, size_t count)
{
    const char *names[] = { "Body", "Clothing" };
    const size_t expected_vertices[] = { 40, 32 }, expected_triangles[] = { 76, 48 };
    const ufbx_mesh *source[] = { find_mesh(original, names[0]), find_mesh(original, names[1]) };
    const ufbx_mesh *output[] = { find_mesh(exported, names[0]), find_mesh(exported, names[1]) };
    const bool source_shared = shared_skeleton(original, source, 2), output_shared = shared_skeleton(exported, output, count);
    printf("{\"originalSharedSkeleton\":%s,\"exportedSharedSkeleton\":%s,\"originalBoneCount\":%zu,\"exportedBoneCount\":%zu,\"meshes\":[",
           source_shared ? "true" : "false", output_shared ? "true" : "false", original->bones.count, exported->bones.count);
    bool compatible = source_shared && output_shared && original->anim_stacks.count == 1 && exported->anim_stacks.count == 1;
    if (source_shared && output_shared) {
        for (size_t i = 0; i < count; i++) {
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

static double rig_weight(const ufbx_mesh *mesh, size_t vertex, const char *bone)
{
    const ufbx_skin_deformer *skin = mesh->skin_deformers.data[0];
    const ufbx_skin_vertex row = skin->vertices.data[vertex];
    double result = 0;
    for (size_t i = 0; i < row.num_weights; i++) {
        const ufbx_skin_weight weight = skin->weights.data[row.weight_begin + i];
        if (!strcmp(skin->clusters.data[weight.cluster_index]->bone_node->name.data, bone)) result += weight.weight;
    }
    return result;
}

static bool weight_target(bool wide, size_t vertex)
{
    return wide ? vertex == 2 || vertex == 3 : vertex == 4;
}

static double expected_weight(const ufbx_mesh *source, size_t vertex, const char *bone, bool wide)
{
    const double weight = rig_weight(source, vertex, bone);
    if (!weight_target(wide, vertex)) return weight;
    if (!wide) return !strcmp(bone, "Palm") ? .625 : !strcmp(bone, "LeftFinger") ? .375 : 0;
    if (!strcmp(bone, "Joint1")) return weight;
    return !strcmp(bone, "Joint5") ? 0 : weight * (22.0 / 19.0);
}

static bool compare_weight_edit(const ufbx_scene *original, const ufbx_scene *exported, bool wide)
{
    const ufbx_mesh *a = original->meshes.data[0], *b = exported->meshes.data[0];
    if (!same_connectivity(a, b) || a->skin_deformers.count != 1 || b->skin_deformers.count != 1 ||
        original->anim_stacks.count != 1 || exported->anim_stacks.count != 1) return false;
    const ufbx_anim_stack *take = original->anim_stacks.data[0], *result = exported->anim_stacks.data[0];
    const double duration = take->time_end - take->time_begin;
    if (strcmp(take->name.data, result->name.data) || fabs(duration - (result->time_end - result->time_begin)) > 1e-6) return false;
    const ufbx_skin_deformer *skin_a = a->skin_deformers.data[0], *skin_b = b->skin_deformers.data[0];
    if (skin_a->clusters.count != (wide ? 5 : 3) || skin_b->max_weights_per_vertex > 4) return false;
    double base = 0, weights = 0, normalized = 0, uv = 0, seam = 0, bind = 0;
    bool got_uv = false;
    ufbx_vec2 first_uv = { .x = 0, .y = 0 };
    if (a->vertex_uv.exists != b->vertex_uv.exists || a->vertex_normal.exists != b->vertex_normal.exists) return false;
    for (size_t i = 0; i < a->num_indices; i++) {
        if (a->vertex_normal.exists && normal_angle(ufbx_get_vertex_vec3(&a->vertex_normal, i), ufbx_get_vertex_vec3(&b->vertex_normal, i)) > 1e-5) return false;
        if (a->vertex_uv.exists) {
            const ufbx_vec2 left = ufbx_get_vertex_vec2(&a->vertex_uv, i), right = ufbx_get_vertex_vec2(&b->vertex_uv, i);
            uv = fmax(uv, hypot(left.x - right.x, left.y - right.y));
            if (a->vertex_indices.data[i] == 4) {
                if (got_uv) seam = fmax(seam, hypot(left.x - first_uv.x, left.y - first_uv.y));
                else first_uv = left;
                got_uv = true;
            }
        }
    }
    for (size_t i = 0; i < a->num_vertices; i++) {
        double sum = 0;
        base = fmax(base, point_distance(a->vertices.data[i], b->vertices.data[i]));
        for (size_t j = 0; j < skin_a->clusters.count; j++) {
            const ufbx_skin_cluster *source = skin_a->clusters.data[j];
            const char *bone = source->bone_node->name.data;
            const double observed = rig_weight(b, i, bone);
            weights = fmax(weights, fabs(observed - expected_weight(a, i, bone, wide)));
            sum += observed;
            for (size_t k = 0; k < skin_b->clusters.count; k++) {
                const ufbx_skin_cluster *target = skin_b->clusters.data[k];
                if (strcmp(bone, target->bone_node->name.data)) continue;
                for (size_t m = 0; m < 12; m++) bind = fmax(bind, fabs(source->geometry_to_bone.v[m] - target->geometry_to_bone.v[m]));
            }
        }
        normalized = fmax(normalized, fabs(sum - 1));
    }
    double deformation = 0, unaffected = 0, predicted = 0;
    const double meters = original->settings.unit_meters;
    for (size_t t = 0; t <= 20; t++) {
        const double time = duration * t / 20.0;
        ufbx_scene *left = evaluate(original, take, take->time_begin + time), *right = evaluate(exported, result, result->time_begin + time);
        const ufbx_skin_deformer *sample = left->meshes.data[0]->skin_deformers.data[0];
        for (size_t i = 0; i < a->num_vertices; i++) {
            const ufbx_vec3 source = posed_point(left, 0, i), target = posed_point(right, 0, i);
            ufbx_vec3 expected = { .x = 0, .y = 0, .z = 0 };
            for (size_t j = 0; j < sample->clusters.count; j++) {
                const ufbx_skin_cluster *cluster = sample->clusters.data[j];
                const ufbx_vec3 point = ufbx_transform_position(&cluster->geometry_to_world, a->vertices.data[i]);
                const double weight = expected_weight(a, i, cluster->bone_node->name.data, wide) * meters;
                expected.x += point.x * weight;
                expected.y += point.y * weight;
                expected.z += point.z * weight;
            }
            predicted = fmax(predicted, point_distance(expected, target));
            const double delta = point_distance(source, target);
            if (weight_target(wide, i)) deformation = fmax(deformation, delta);
            else unaffected = fmax(unaffected, delta);
        }
        ufbx_free_scene(right);
        ufbx_free_scene(left);
    }
    const bool compatible = base <= 1e-9 && uv <= 1e-9 && bind <= 1e-9 && weights <= 1e-6 && normalized <= 1e-6 &&
        (wide || seam > .1) && deformation > .005 && unaffected <= 1e-6 && predicted <= 1e-6;
    printf("{\"mode\":\"%s\",\"vertices\":%zu,\"samples\":21,\"maxInfluences\":%zu,\"baseDelta\":%.9g,\"uvDelta\":%.9g,"
           "\"uvSeamSpan\":%.9g,\"bindDelta\":%.9g,\"weightError\":%.9g,\"normalizationError\":%.9g,\"changedDeformationMeters\":%.9g,"
           "\"unaffectedDeformationMeters\":%.9g,\"predictionErrorMeters\":%.9g,\"compatible\":%s}\n", wide ? "wide" : "stroke", a->num_vertices,
           skin_b->max_weights_per_vertex, base, uv, seam, bind, weights, normalized, deformation, unaffected, predicted, compatible ? "true" : "false");
    return compatible;
}

static bool compare_edited_rig(const ufbx_scene *original, const ufbx_scene *exported, const char *mode)
{
    const bool moved = !strcmp(mode, "--rig-moved"), deleted = !strcmp(mode, "--rig-deleted");
    const char *clip_name = moved ? "SharedTorsoBend_Adapted_1" : "SharedTorsoBend";
    const ufbx_node *pelvis = ufbx_find_node(exported, "Pelvis"), *chest = ufbx_find_node(exported, "Chest");
    const ufbx_node *spine = ufbx_find_node(exported, moved || deleted ? "Spine" : "MidSpine");
    const ufbx_node *child = ufbx_find_node(exported, "ProbeChild");
    const ufbx_node *old_spine = ufbx_find_node(original, "Spine"), *old_chest = ufbx_find_node(original, "Chest");
    if (!pelvis || !chest || (deleted ? spine || !child || child->parent != pelvis : !spine || spine->parent != pelvis) ||
        chest->parent != (deleted ? pelvis : spine) || exported->anim_stacks.count != (deleted ? 0 : 1)) return false;
    const ufbx_anim_stack *take = deleted ? NULL : exported->anim_stacks.data[0];
    if (take && (strcmp(take->name.data, clip_name) || fabs(take->time_end - take->time_begin - 1) > 1e-5)) return false;
    const double joint_move = spine ? point_distance(old_spine->node_to_world.cols[3], spine->node_to_world.cols[3]) : 0;
    const double chest_move = point_distance(old_chest->node_to_world.cols[3], chest->node_to_world.cols[3]);
    const double meters = exported->settings.unit_meters;
    const ufbx_evaluate_opts opts = { .evaluate_skinning = true };
    const ufbx_anim bind = { 0 };
    ufbx_scene *rest = ufbx_evaluate_scene(exported, &bind, 0, &opts, NULL);
    if (!rest) return false;
    const char *mesh_names[] = { "Body", "Clothing" };
    bool ok = fabs(joint_move * meters - (moved ? .12 : 0)) <= 1e-6 && chest_move * meters <= 1e-6;
    printf("{\"mode\":\"%s\",\"jointDisplacementMeters\":%.9g,\"descendantDisplacementMeters\":%.9g,\"meshes\":[", mode, joint_move * meters, chest_move * meters);
    for (size_t i = 0; i < 2; i++) {
        const ufbx_mesh *a = find_mesh(original, mesh_names[i]), *b = find_mesh(exported, mesh_names[i]);
        if (!a || !b || a->skin_deformers.count != 1 || b->skin_deformers.count != 1 || !same_connectivity(a, b)) {
            ufbx_free_scene(rest);
            return false;
        }
        const ufbx_skin_cluster_list clusters = b->skin_deformers.data[0]->clusters;
        bool bound[3] = { false, false, false };
        double bind_error = 0;
        for (size_t j = 0; j < clusters.count; j++) {
            const ufbx_skin_cluster *cluster = clusters.data[j];
            const ufbx_node *bone = cluster->bone_node;
            bound[0] |= bone == pelvis;
            bound[1] |= bone == (deleted ? child : spine);
            bound[2] |= bone == chest;
            const ufbx_matrix matrix = ufbx_matrix_mul(&bone->node_to_world, &cluster->geometry_to_bone);
            for (size_t k = 0; k < 12; k++) bind_error = fmax(bind_error, fabs(matrix.v[k] - b->instances.data[0]->geometry_to_world.v[k]));
        }
        double weight = 0, rest_err = 0, deformation = 0, pose_err = 0, base = 0, uv = 0;
        for (size_t j = 0; j < a->num_vertices; j++) {
            const double from_spine = rig_weight(a, j, "Spine");
            const double from_pelvis = rig_weight(a, j, "Pelvis");
            weight = fmax(weight, fabs(rig_weight(b, j, "Pelvis") - from_pelvis - (deleted ? from_spine : 0)));
            weight = fmax(weight, fabs(rig_weight(b, j, moved ? "Spine" : deleted ? "ProbeChild" : "MidSpine") - (deleted ? 0 : from_spine)));
            weight = fmax(weight, fabs(rig_weight(b, j, "Chest") - rig_weight(a, j, "Chest")));
            base = fmax(base, point_distance(a->vertices.data[j], b->vertices.data[j]));
            const ufbx_vec3 p = ufbx_transform_position(&b->instances.data[0]->geometry_to_world, b->vertices.data[j]);
            rest_err = fmax(rest_err, point_distance((ufbx_vec3){.x = p.x * meters, .y = p.y * meters, .z = p.z * meters}, posed_point(rest, b->typed_id, j)));
        }
        for (size_t j = 0; j < a->num_indices; j++) {
            const ufbx_vec2 x = ufbx_get_vertex_vec2(&a->vertex_uv, j), y = ufbx_get_vertex_vec2(&b->vertex_uv, j);
            uv = fmax(uv, hypot(x.x - y.x, x.y - y.y));
        }
        if (take) for (size_t t = 0; t <= 20; t++) {
            const ufbx_anim_stack *source = original->anim_stacks.data[0];
            ufbx_scene *sample = evaluate(exported, take, take->time_begin + t / 20.0);
            ufbx_scene *source_sample = evaluate(original, source, source->time_begin + t / 20.0);
            const ufbx_vec3 origin = posed_point(sample, b->typed_id, 0), start = posed_point(rest, b->typed_id, 0);
            for (size_t j = 0; j < b->num_vertices; j++) {
                const ufbx_vec3 p = posed_point(sample, b->typed_id, j), q = posed_point(rest, b->typed_id, j);
                deformation = fmax(deformation, fabs(point_distance(p, origin) - point_distance(q, start)));
                pose_err = fmax(pose_err, point_distance(p, posed_point(source_sample, a->typed_id, j)));
            }
            ufbx_free_scene(source_sample);
            ufbx_free_scene(sample);
        }
        const bool shared = bound[0] && (deleted || bound[1]) && bound[2] && clusters.count <= 3;
        ok &= shared && base <= 1e-9 && uv <= 1e-9 && weight <= 1e-6 && rest_err <= 1e-6 && bind_error <= 1e-6 &&
            (!take || (deformation > .01 && (moved || pose_err <= 1e-6)));
        printf("%s{\"name\":\"%s\",\"shared\":%s,\"baseDelta\":%.9g,\"uvDelta\":%.9g,\"weightDelta\":%.9g,"
               "\"restErrorMeters\":%.9g,\"bindMatrixError\":%.9g,\"shapeChangeMeters\":%.9g,\"differenceFromOriginalClipMeters\":%.9g}",
               i ? "," : "", mesh_names[i], shared ? "true" : "false", base, uv, weight, rest_err, bind_error, deformation, pose_err);
    }
    ufbx_free_scene(rest);
    printf("],\"compatible\":%s}\n", ok ? "true" : "false");
    return ok;
}

static bool inspect_adverse_source(const ufbx_scene *scene)
{
    const ufbx_mesh *mesh = scene->meshes.data[0];
    if (mesh->num_vertices != 6 || mesh->num_triangles != 4 || mesh->skin_deformers.count != 1) return false;
    const ufbx_skin_deformer *skin = mesh->skin_deformers.data[0];
    if (scene->bones.count != 5 || skin->clusters.count != 5 || skin->max_weights_per_vertex != 5) return false;
    const double expected[] = { 0.3125, 0.25, 0.1875, 0.15625, 0.09375 };
    double observed[2][5] = { 0 };
    for (size_t bone = 0; bone < 5; bone++) {
        const ufbx_skin_cluster *cluster = skin->clusters.data[bone];
        char name[] = "Joint1";
        name[5] += (char)bone;
        if (!cluster->bone_node || strcmp(cluster->bone_node->name.data, name) != 0) return false;
        for (size_t i = 0; i < cluster->num_weights; i++) {
            const uint32_t point = cluster->vertices.data[i];
            if (point == 2 || point == 3) observed[point - 2][bone] = cluster->weights.data[i];
        }
    }
    for (size_t point = 0; point < 2; point++) {
        if (skin->vertices.data[point + 2].num_weights != 5 || memcmp(observed[point], expected, sizeof(expected)) != 0) return false;
    }

    const bool has_morphs = mesh->blend_deformers.count != 0;
    if (has_morphs) {
        if (mesh->blend_deformers.count != 1) return false;
        const ufbx_blend_channel_list channels = mesh->blend_deformers.data[0]->channels;
        if (channels.count != 2) return false;
        bool raise = false, widen = false;
        for (size_t i = 0; i < channels.count; i++) {
            const ufbx_blend_channel *channel = channels.data[i];
            const bool is_raise = strcmp(channel->name.data, "Raise") == 0;
            const bool is_widen = strcmp(channel->name.data, "Widen") == 0;
            if ((!is_raise && !is_widen) || channel->keyframes.count != 1 || !channel->target_shape) return false;
            raise |= is_raise;
            widen |= is_widen;
            for (size_t point = 0; point < mesh->num_vertices; point++) {
                const ufbx_vec3 offset = ufbx_get_blend_shape_vertex_offset(channel->target_shape, point);
                const double x = is_widen ? (point == 3 ? 0.0625 : point == 5 ? 0.1875 : 0.0) : 0.0;
                const double z = is_raise ? (point == 2 ? 0.125 : point == 4 ? 0.25 : 0.0) : 0.0;
                if (offset.x != x || offset.y != 0.0 || offset.z != z) return false;
            }
        }
        if (!raise || !widen) return false;
    }
    printf("{\"bones\":5,\"maxInfluences\":5,\"pointsWithFiveInfluences\":[2,3],"
           "\"weightsAtBothPoints\":[%.9g,%.9g,%.9g,%.9g,%.9g],\"verifiedMorphDeltas\":%s}\n",
           observed[0][0], observed[0][1], observed[0][2], observed[0][3], observed[0][4], has_morphs ? "[\"Raise\",\"Widen\"]" : "[]");
    return true;
}

static size_t shared_midpoint(const ufbx_mesh *mesh, uint32_t vertex, uint32_t a, uint32_t b, double *uv_gap, double *normal_gap)
{
    size_t copies[2], count = 0;
    for (size_t f = 0; f < mesh->num_faces; f++) {
        const ufbx_face face = mesh->faces.data[f];
        for (size_t p = 0; p < face.num_indices; p++) {
            const size_t i = face.index_begin + p;
            if (mesh->vertex_indices.data[i] != vertex) continue;
            if (count == 2 || face.num_indices != 4) return 0;
            const size_t prev = face.index_begin + (p + face.num_indices - 1) % face.num_indices;
            const size_t next = face.index_begin + (p + 1) % face.num_indices;
            const uint32_t u = mesh->vertex_indices.data[prev], v = mesh->vertex_indices.data[next];
            if (!((u == a && v == b) || (u == b && v == a))) return 0;
            const ufbx_vec2 x = ufbx_get_vertex_vec2(&mesh->vertex_uv, prev), y = ufbx_get_vertex_vec2(&mesh->vertex_uv, next);
            const ufbx_vec2 expected = { .x = (x.x + y.x) * 0.5, .y = (x.y + y.y) * 0.5 };
            if (uv_distance(expected, ufbx_get_vertex_vec2(&mesh->vertex_uv, i)) > 1e-8) return 0;
            copies[count++] = i;
        }
    }
    if (count == 2) {
        *uv_gap = uv_distance(ufbx_get_vertex_vec2(&mesh->vertex_uv, copies[0]), ufbx_get_vertex_vec2(&mesh->vertex_uv, copies[1]));
        *normal_gap = normal_angle(ufbx_get_vertex_vec3(&mesh->vertex_normal, copies[0]), ufbx_get_vertex_vec3(&mesh->vertex_normal, copies[1]));
    }
    return count;
}

static double weight_at(const ufbx_mesh *mesh, size_t vertex, const char *bone)
{
    const ufbx_skin_deformer *skin = mesh->skin_deformers.data[0];
    const ufbx_skin_vertex data = skin->vertices.data[vertex];
    for (size_t i = 0; i < data.num_weights; i++) {
        const ufbx_skin_weight weight = skin->weights.data[data.weight_begin + i];
        if (!strcmp(skin->clusters.data[weight.cluster_index]->bone_node->name.data, bone)) return weight.weight;
    }
    return 0.0;
}

static bool e04_mesh_report(char **paths)
{
    ufbx_scene *source = load(paths[0], 1), *moved = load(paths[1], 1), *split = load(paths[2], 1), *undone = load(paths[3], 1);
    ufbx_scene *holes = load(paths[4], 1), *original = load(paths[5], 1), *skinned = load(paths[6], 1), *pieces = load(paths[7], 2);
    const ufbx_mesh *a = source->meshes.data[0], *b = moved->meshes.data[0], *c = split->meshes.data[0], *d = undone->meshes.data[0];
    const ufbx_mesh *h = holes->meshes.data[0], *rig = original->meshes.data[0], *s = skinned->meshes.data[0];
    bool move_ok = same_connectivity(a, b) && a->num_vertices == 11 && moved->textures.count == 1;
    if (move_ok) for (size_t i = 0; i < a->num_vertices; i++) {
        ufbx_vec3 expected = a->vertices.data[i];
        if (i == 0) expected.y += 0.03125;
        move_ok &= point_distance(expected, b->vertices.data[i]) < 1e-10;
    }
    const bool undo_ok = same_connectivity(b, d) && !memcmp(b->vertices.data, d->vertices.data, b->num_vertices * sizeof(ufbx_vec3))
        && b->vertex_uv.exists && d->vertex_uv.exists && b->vertex_normal.exists && d->vertex_normal.exists;
    bool undo_corners = undo_ok;
    if (undo_ok) for (size_t i = 0; i < b->num_indices; i++) {
        undo_corners &= uv_distance(ufbx_get_vertex_vec2(&b->vertex_uv, i), ufbx_get_vertex_vec2(&d->vertex_uv, i)) == 0.0 &&
            normal_angle(ufbx_get_vertex_vec3(&b->vertex_normal, i), ufbx_get_vertex_vec3(&d->vertex_normal, i)) < 1e-5;
    }
    double uv_gap = 0, normal_gap = 0;
    bool split_ok = c->num_vertices == 12 && c->num_triangles == 15 && c->vertex_uv.exists && c->vertex_normal.exists &&
        point_distance(c->vertices.data[11], (ufbx_vec3){ .x = 0.5, .y = 0.015625, .z = 0.0 }) < 1e-10 &&
        shared_midpoint(c, 11, 0, 1, &uv_gap, &normal_gap) == 2 && uv_gap > 0.1 && normal_gap > 80.0;
    const bool holes_ok = h->num_faces == 16 && h->num_triangles == 33 && h->vertex_uv.exists && h->vertex_normal.exists &&
        h->faces.data[13].num_indices == 3 && h->faces.data[14].num_indices == 4 && h->faces.data[15].num_indices == 6 &&
        holes->textures.count == 1;
    double skin_uv = 0, skin_normal = 0;
    bool skin_ok = rig->num_vertices == 6 && s->num_vertices == 7 && s->num_faces == 4 && s->num_triangles == 6 &&
        s->skin_deformers.count == 1 && rig->skin_deformers.count == 1 && s->vertex_uv.exists &&
        shared_midpoint(s, 6, 1, 2, &skin_uv, &skin_normal) == 2 &&
        fabs(weight_at(s, 6, "Base") - 0.75) < 1e-9 && fabs(weight_at(s, 6, "Elbow") - 0.25) < 1e-9;
    if (skin_ok) for (size_t i = 0; i < rig->num_vertices; i++) {
        skin_ok &= point_distance(rig->vertices.data[i], s->vertices.data[i]) < 1e-10 &&
            weight_at(rig, i, "Base") == weight_at(s, i, "Base") && weight_at(rig, i, "Elbow") == weight_at(s, i, "Elbow");
    }
    const ufbx_mesh *left = pieces->meshes.data[0], *right = pieces->meshes.data[1];
    bool piece_ok = pieces->anim_stacks.count == 1 && pieces->bones.count == 2 &&
        left->num_triangles + right->num_triangles == 6 && left->skin_deformers.count == 1 && right->skin_deformers.count == 1;
    if (piece_ok) {
        const ufbx_skin_cluster_list x = left->skin_deformers.data[0]->clusters, y = right->skin_deformers.data[0]->clusters;
        piece_ok = x.count == 2 && y.count == 2 && x.data[0]->bone_node == y.data[0]->bone_node && x.data[1]->bone_node == y.data[1]->bone_node;
    }
    printf("{\"move\":%s,\"undo\":%s,\"splitSeam\":%s,\"splitUvGap\":%.9g,\"splitNormalAngle\":%.9g,"
            "\"threeContours\":%s,\"weightedSplit\":%s,\"sharedSkinAfterSeparate\":%s",
            move_ok ? "true" : "false", undo_corners ? "true" : "false", split_ok ? "true" : "false", uv_gap, normal_gap,
            holes_ok ? "true" : "false", skin_ok ? "true" : "false", piece_ok ? "true" : "false");
    const bool clip_ok = skin_ok && compare_clips(original, skinned, rig, s);
    puts("}");
    ufbx_scene *scenes[] = { source, moved, split, undone, holes, original, skinned, pieces };
    for (size_t i = 0; i < sizeof(scenes) / sizeof(scenes[0]); i++) ufbx_free_scene(scenes[i]);
    return move_ok && undo_corners && split_ok && holes_ok && skin_ok && piece_ok && clip_ok;
}

static bool bottle_changes(const ufbx_mesh *source, const ufbx_mesh *result, bool fan)
{
    if (source->num_vertices != 60 || source->num_faces != 104 || result->num_vertices != 60u + (fan ? 1u : 0u) ||
        result->num_faces != 104u + (fan ? 3u : 2u) || !source->vertex_uv.exists || !result->vertex_uv.exists ||
        !source->vertex_normal.exists || !result->vertex_normal.exists) return false;
    if (memcmp(source->vertices.data, result->vertices.data, source->num_vertices * sizeof(ufbx_vec3)) ||
        memcmp(source->vertex_indices.data, result->vertex_indices.data, source->num_indices * sizeof(uint32_t))) return false;
    double min = INFINITY, max = -INFINITY;
    for (size_t i = 0; i < source->num_indices; i++) {
        const ufbx_vec2 uv = ufbx_get_vertex_vec2(&source->vertex_uv, i);
        if (uv_distance(uv, ufbx_get_vertex_vec2(&result->vertex_uv, i)) > 1e-9 ||
            normal_angle(ufbx_get_vertex_vec3(&source->vertex_normal, i), ufbx_get_vertex_vec3(&result->vertex_normal, i)) > 1e-5) return false;
        if (source->vertex_indices.data[i] == 12) {
            min = fmin(min, uv.x);
            max = fmax(max, uv.x);
        }
    }
    if (max - min < .99) return false;
    unsigned char adjacency[61][61] = { 0 };
    for (size_t f = 0; f < result->num_faces; f++) {
        const ufbx_face face = result->faces.data[f];
        if (face.num_indices != 3) return false;
        for (size_t i = 0; i < 3; i++) {
            unsigned a = result->vertex_indices.data[face.index_begin + i];
            unsigned b = result->vertex_indices.data[face.index_begin + (i + 1) % 3];
            if (a == b || adjacency[a][b]++) return false;
        }
    }
    size_t open = 0;
    for (unsigned a = 0; a < 61; a++) for (unsigned b = a + 1; b < 61; b++) {
        if (adjacency[a][b] + adjacency[b][a] != 1) continue;
        const bool mouth = a >= 48 && b < 60 && (b == a + 1 || (a == 48 && b == 59));
        const bool second_hole = fan && ((a == 20 && b == 21) || (a == 20 && b == 32) || (a == 21 && b == 32));
        if (!mouth && !second_hole) return false;
        open++;
    }
    return open == (fan ? 15u : 12u);
}

static bool e05_mesh_report(char **paths)
{
    ufbx_scene *source = load(paths[0], 1), *repair = load(paths[1], 1);
    ufbx_scene *rig = load(paths[2], 1), *fan = load(paths[3], 1);
    const ufbx_mesh *a = source->meshes.data[0], *b = repair->meshes.data[0], *c = rig->meshes.data[0], *d = fan->meshes.data[0];
    const bool planar = bottle_changes(a, b, false) && repair->textures.count == 1;
    bool skinned = bottle_changes(c, d, true) && c->skin_deformers.count == 1 && d->skin_deformers.count == 1 && fan->textures.count == 1;
    double w0 = 0.0, w1 = 0.0;
    if (skinned) {
        w0 = weight_at(d, 60, "Base");
        w1 = weight_at(d, 60, "Neck");
        skinned = fabs(w0 - 5.0 / 6.0) < 1e-9 && fabs(w1 - 1.0 / 6.0) < 1e-9;
        for (size_t i = 0; i < 60; i++) {
            skinned &= weight_at(c, i, "Base") == weight_at(d, i, "Base") && weight_at(c, i, "Neck") == weight_at(d, i, "Neck");
        }
    }
    printf("{\"staticPatchPreservedBoundaryAndCorners\":%s,\"fanPreservedBoundaryAndCorners\":%s,\"newWeights\":[%.10g,%.10g]",
        planar ? "true" : "false", skinned ? "true" : "false", w0, w1);
    const bool clip = skinned && compare_clips(rig, fan, c, d);
    puts("}");
    ufbx_free_scene(source); ufbx_free_scene(repair); ufbx_free_scene(rig); ufbx_free_scene(fan);
    return planar && skinned && clip;
}

int main(int argc, char **argv)
{
    if (argc == 10 && !strcmp(argv[1], "--e04")) return e04_mesh_report(argv + 2) ? 0 : 1;
    if (argc == 6 && !strcmp(argv[1], "--e05")) return e05_mesh_report(argv + 2) ? 0 : 1;
    if (argc == 3 && strcmp(argv[1], "--f12-source") == 0) {
        ufbx_scene *scene = load(argv[2], 1);
        const bool matches = inspect_coordinate_source(scene);
        if (!matches) fprintf(stderr, "F12 axes, hierarchy or clip expectations failed in %s.\n", argv[2]);
        ufbx_free_scene(scene);
        return matches ? 0 : 1;
    }
    if (argc == 3 && strcmp(argv[1], "--f13-source") == 0) {
        ufbx_scene *scene = load(argv[2], 1);
        const bool matches = inspect_adverse_source(scene);
        if (!matches) fprintf(stderr, "F13 weight or morph expectations failed in %s.\n", argv[2]);
        ufbx_free_scene(scene);
        return matches ? 0 : 1;
    }
    const bool selected = argc == 4 && strcmp(argv[3], "--selected-skin") == 0;
    const bool shared = argc == 4 && (selected || strcmp(argv[3], "--shared-skin") == 0);
    const bool rig = argc == 4 && (!strcmp(argv[3], "--rig-moved") || !strcmp(argv[3], "--rig-renamed") || !strcmp(argv[3], "--rig-deleted"));
    const bool weight = argc == 4 && (!strcmp(argv[3], "--weight-stroke") || !strcmp(argv[3], "--weight-wide"));
    const bool stitch = argc == 4 && strcmp(argv[3], "--uv-stitch") == 0;
    if (argc != 3 && argc != 5 && !shared && !rig && !weight && !stitch) {
        fprintf(stderr, "Usage: inspect_fbx original.fbx exported.fbx [--shared-skin | --selected-skin | --rig-moved | --rig-renamed | --rig-deleted | --weight-stroke | --weight-wide | --uv-stitch | control-point offset-y | --seams offset-y | --atlas source-corners.bin | --baked source-corners.bin | --smooth center | --grid center]\n");
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
    ufbx_scene *original = load(argv[1], shared || rig ? 2 : 1);
    ufbx_scene *exported = load(argv[2], (shared && !selected) || rig ? 2 : 1);
    if (weight) {
        const bool matches = compare_weight_edit(original, exported, !strcmp(argv[3], "--weight-wide"));
        ufbx_free_scene(exported);
        ufbx_free_scene(original);
        return matches ? 0 : 1;
    }
    if (shared || rig) {
        const bool matches = shared ? compare_shared_skin(original, exported, selected ? 1 : 2) : compare_edited_rig(original, exported, argv[3]);
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
    const bool stitched_uv = !stitch || (topology && compare_stitched_uv(a, b));
    puts("}");
    ufbx_free_scene(exported);
    ufbx_free_scene(original);
    return topology && weights && edit_matches && animation && stitched_uv ? 0 : 1;
}
