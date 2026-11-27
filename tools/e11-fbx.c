/* Independent verification of the E11 diagnostic stack and frozen weight stroke. */
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "ufbx.h"

static const char *clips[] = { "SourceStep", "Diagnostic_idle", "Diagnostic_walk", "Diagnostic_run", "Diagnostic_jump",
    "Diagnostic_squat", "Diagnostic_sit", "Diagnostic_wave", "Diagnostic_punch", "Diagnostic_reach", "Diagnostic_twist" };

static ufbx_scene *load(const char *path)
{
    ufbx_error error;
    ufbx_scene *scene = ufbx_load_file(path, NULL, &error);
    if (!scene || scene->meshes.count != 1 || scene->meshes.data[0]->skin_deformers.count != 1) {
        char message[1024] = "Expected one skinned mesh.";
        if (!scene) ufbx_format_error(message, sizeof(message), &error);
        fprintf(stderr, "%s: %s\n", path, message);
        exit(1);
    }
    return scene;
}

static const ufbx_anim_stack *take(const ufbx_scene *scene, const char *name)
{
    for (size_t i = 0; i < scene->anim_stacks.count; i++) if (!strcmp(scene->anim_stacks.data[i]->name.data, name)) return scene->anim_stacks.data[i];
    fprintf(stderr, "Missing clip %s.\n", name);
    exit(1);
}

static ufbx_scene *sample(const ufbx_scene *scene, const ufbx_anim_stack *stack, double fraction)
{
    const ufbx_evaluate_opts opts = { .evaluate_skinning = true };
    const double seconds = stack->time_begin + (stack->time_end - stack->time_begin) * fraction;
    ufbx_scene *pose = ufbx_evaluate_scene(scene, stack->anim, seconds, &opts, NULL);
    if (!pose) exit(1);
    return pose;
}

static double distance(ufbx_vec3 a, ufbx_vec3 b)
{
    return hypot(hypot(a.x - b.x, a.y - b.y), a.z - b.z);
}

static ufbx_vec3 hips(const ufbx_scene *pose)
{
    const ufbx_node *bone = ufbx_find_node(pose, "Hips");
    if (!bone) exit(1);
    return bone->node_to_world.cols[3];
}

static ufbx_vec3 deformed(const ufbx_mesh *mesh, size_t id)
{
    const ufbx_vec3 point = mesh->skinned_position.values.data[id];
    return mesh->skinned_is_local ? ufbx_transform_position(&mesh->instances.data[0]->geometry_to_world, point) : point;
}

static double weight(const ufbx_skin_deformer *skin, size_t vertex, const char *name)
{
    const ufbx_skin_vertex row = skin->vertices.data[vertex];
    double result = 0;
    for (size_t i = 0; i < row.num_weights; i++) {
        const ufbx_skin_weight item = skin->weights.data[row.weight_begin + i];
        if (!strcmp(skin->clusters.data[item.cluster_index]->bone_node->name.data, name)) result += item.weight;
    }
    return result;
}

static bool stroke_vertices(size_t vertex) { return vertex == 0 || vertex == 1 || vertex == 8; }

static double expected_weight(const ufbx_skin_deformer *source, size_t vertex, const char *name)
{
    if (!stroke_vertices(vertex)) return weight(source, vertex, name);
    return !strcmp(name, "Hips") ? .7 : !strcmp(name, "Spine") ? .3 : 0;
}

static bool unchanged_base(const ufbx_mesh *a, const ufbx_mesh *b, bool edited)
{
    if (a->num_vertices != b->num_vertices || a->num_indices != b->num_indices || a->num_faces != b->num_faces ||
        memcmp(a->vertex_indices.data, b->vertex_indices.data, a->num_indices * sizeof(uint32_t))) return false;
    const ufbx_skin_deformer *s = a->skin_deformers.data[0], *t = b->skin_deformers.data[0];
    if (s->clusters.count != t->clusters.count) return false;
    for (size_t i = 0; i < a->num_vertices; i++) if (distance(a->vertices.data[i], b->vertices.data[i]) > 1e-9) return false;
    for (size_t i = 0; i < a->num_indices; i++) {
        const ufbx_vec2 x = ufbx_get_vertex_vec2(&a->vertex_uv, i), y = ufbx_get_vertex_vec2(&b->vertex_uv, i);
        if (hypot(x.x - y.x, x.y - y.y) > 1e-9) return false;
    }
    for (size_t i = 0; i < s->clusters.count; i++) {
        const ufbx_skin_cluster *left = s->clusters.data[i], *right = t->clusters.data[i];
        const char *name = left->bone_node->name.data;
        if (strcmp(name, right->bone_node->name.data)) return false;
        for (size_t k = 0; k < 12; k++) if (fabs(left->geometry_to_bone.v[k] - right->geometry_to_bone.v[k]) > 1e-9) return false;
        for (size_t v = 0; v < a->num_vertices; v++) {
            const double expected = edited ? expected_weight(s, v, name) : weight(s, v, name);
            if (fabs(expected - weight(t, v, name)) > 1e-9) return false;
        }
    }
    return true;
}

static bool close_reference(const ufbx_scene *a, const ufbx_scene *b)
{
    for (size_t i = 0; i <= 20; i++) {
        ufbx_scene *x = sample(a, take(a, "SourceStep"), i / 20.0), *y = sample(b, take(b, "SourceStep"), i / 20.0);
        double error = 0;
        for (size_t j = 0; j < x->meshes.data[0]->num_vertices; j++) error = fmax(error, distance(deformed(x->meshes.data[0], j), deformed(y->meshes.data[0], j)));
        ufbx_free_scene(x); ufbx_free_scene(y);
        if (error > 1e-6) return false;
    }
    return true;
}

static bool verify(const ufbx_scene *a, const ufbx_scene *p, const ufbx_scene *b)
{
    size_t count = sizeof(clips) / sizeof(clips[0]);
    if (a->anim_stacks.count != 1 || p->anim_stacks.count != 1 || b->anim_stacks.count != count || a->bones.count != b->bones.count ||
        distance(hips(a), hips(b)) > 1e-9 || distance(hips(a), hips(p)) > 1e-9 ||
        !unchanged_base(a->meshes.data[0], p->meshes.data[0], false) || !unchanged_base(a->meshes.data[0], b->meshes.data[0], true) || !close_reference(a, p)) {
        fprintf(stderr, "The base mesh, binding, weights or preview round-trip failed.\n");
        return false;
    }
    const char *forearms[] = { "LeftForearm", "RightForearm" }, *twists[] = { "LeftArmTwist", "RightArmTwist" };
    for (size_t i = 0; i < 2; i++) {
        const ufbx_node *joint = ufbx_find_node(b, forearms[i]);
        if (!joint || joint->parent != ufbx_find_node(b, twists[i])) return false;
    }
    const ufbx_mesh *original = a->meshes.data[0];
    const ufbx_skin_deformer *source = original->skin_deformers.data[0];
    bool ok = true;
    printf("{\"baseAndBindingPreserved\":true,\"changedControlPoints\":[0,1,8],\"animations\":[");
    for (size_t i = 0; i < count; i++) {
        const ufbx_anim_stack *stack = take(b, clips[i]);
        ufbx_scene *first = sample(b, stack, 0), *last = sample(b, stack, 1), *mid = sample(b, stack, .5);
        double error = 0, motion = 0;
        for (size_t t = 0; t <= 20; t++) {
            ufbx_scene *pose = sample(b, stack, t / 20.0);
            const ufbx_mesh *mesh = pose->meshes.data[0];
            const ufbx_skin_deformer *skin = mesh->skin_deformers.data[0];
            for (size_t v = 0; v < mesh->num_vertices; v++) {
                const ufbx_skin_vertex row = skin->vertices.data[v];
                ufbx_vec3 predicted = { 0 };
                for (size_t j = 0; j < row.num_weights; j++) {
                    const ufbx_skin_weight item = skin->weights.data[row.weight_begin + j];
                    const ufbx_skin_cluster *cluster = skin->clusters.data[item.cluster_index];
                    ufbx_vec3 part = ufbx_transform_position(&cluster->geometry_to_world, original->vertices.data[v]);
                    const double factor = expected_weight(source, v, cluster->bone_node->name.data);
                    predicted.x += factor * part.x; predicted.y += factor * part.y; predicted.z += factor * part.z;
                }
                error = fmax(error, distance(predicted, deformed(mesh, v)));
                motion = fmax(motion, distance(deformed(first->meshes.data[0], v), deformed(mesh, v)));
            }
            ufbx_free_scene(pose);
        }
        const ufbx_vec3 start = hips(first), end = hips(last);
        const double travel = hypot(end.x - start.x, end.z - start.z), drop = start.y - hips(mid).y, offset = start.y - hips(a).y;
        ok &= error <= 1e-6 && motion > .005;
        if (i == 0) ok &= fabs(travel - .44) < 1e-5;
        if (i == 2) ok &= travel > 1;
        if (i == 3) ok &= travel < 1e-6;
        if (i == 5) ok &= drop > .39 && fabs(offset - .035) < 1e-5;
        printf("%s{\"name\":\"%s\",\"samples\":21,\"travelMeters\":%.9g,\"hipDropMeters\":%.9g,\"hipOffsetMeters\":%.9g,"
            "\"maxMovementMeters\":%.9g,\"predictionErrorMeters\":%.9g}", i ? "," : "", clips[i], travel, drop, offset, motion, error);
        ufbx_free_scene(first); ufbx_free_scene(last); ufbx_free_scene(mid);
    }
    printf("],\"compatible\":%s}\n", ok ? "true" : "false");
    return ok;
}

int main(int argc, char **argv)
{
    if (argc != 4) { fprintf(stderr, "Usage: e11-fbx original.fbx preview.fbx published.fbx\n"); return 2; }
    ufbx_scene *a = load(argv[1]), *p = load(argv[2]), *b = load(argv[3]);
    bool ok = verify(a, p, b);
    ufbx_free_scene(b); ufbx_free_scene(p); ufbx_free_scene(a);
    return ok ? 0 : 1;
}
