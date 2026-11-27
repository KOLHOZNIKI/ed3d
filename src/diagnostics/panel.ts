import { BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, Points, PointsMaterial, SkinnedMesh, Vector3 } from 'three';
import { renderControlPoints, sourceMesh } from '../e00/fbx-topology';
import type { Model, ModelAdapter } from '../project/adapter';
import type { AssetDocument } from '../project/document';
import type { WorkingState } from '../project/state';
import type { Viewer } from '../project/viewer';
import { describeAsset, exportReport, inspectCapabilities, type ExportReport } from './report';
import type { Issue } from './state';

type Context = { adapter: ModelAdapter; model: Model; document: AssetDocument<WorkingState> };
const ui = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`asset-${id}`)! as T;

export class AssetPanel {
  #context?: Context;
  #revision = -1;
  #scan: Issue[] = [];
  #last?: ExportReport;
  #overlay = new Group();
  #marker = new Points(new BufferGeometry(), new PointsMaterial({ color: 0xff3fd5, size: 12, sizeAttenuation: false, depthTest: false }));
  #lines = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xff3fd5, depthTest: false }));

  constructor(readonly viewer: Viewer, readonly inspectObject: (object: string) => void) {
    this.#overlay.add(this.#marker, this.#lines);
    viewer.scene.add(this.#overlay);
    this.#overlay.visible = false;
    this.#marker.renderOrder = this.#lines.renderOrder = 50;
    ui<HTMLDetailsElement>('review').ontoggle = () => {
      if (ui<HTMLDetailsElement>('review').open) this.#draw();
      else this.clearMarker();
    };
  }

  configure(context: Context | undefined, locked: boolean) {
    const changed = context?.document !== this.#context?.document || context?.document.revision !== this.#revision;
    this.#context = context;
    this.#revision = context?.document.revision ?? -1;
    ui('review').hidden = !context;
    ui<HTMLFieldSetElement>('review-actions').disabled = locked;
    if (changed) {
      this.#scan = [];
      this.#last = undefined;
      this.clearMarker();
      ui('scan-status').textContent = 'Run a mesh scan for geometry, UV and weight findings.';
      if (ui<HTMLDetailsElement>('review').open) this.#draw();
    }
  }

  get findings() { return this.#scan; }

  scanned(issues: Issue[], global: boolean) {
    this.#scan = issues;
    this.#last = undefined;
    ui('scan-status').textContent = `${global ? 'Mesh and self-intersection' : 'Mesh'} scan complete for revision ${this.#revision}.`;
    this.#draw();
  }

  get report() {
    const { adapter, model, document } = this.#context!;
    return this.#last ?? exportReport(adapter, model, document, this.#scan);
  }

  exported(report: ExportReport) {
    this.#last = report;
    ui('scan-status').textContent = `Export report is ready for revision ${report.project.revision}.`;
  }

  clearMarker() {
    this.#overlay.visible = false;
    for (const item of [this.#marker, this.#lines]) {
      item.geometry.dispose();
      item.geometry = new BufferGeometry();
    }
    this.viewer.render();
  }

  #draw() {
    const context = this.#context;
    if (!context) return;
    const { adapter, model, document } = context, description = describeAsset(adapter, document.state, model);
    ui('summary').textContent = `${description.objects.length} meshes · ${description.triangles.toLocaleString()} triangles · ` +
      `${description.materialCount} materials · ${description.maps.length} maps · ${model.stats.bones} bones · ${model.scene.animations.length} active clips.` +
      ` Decoded RGBA estimate ${(description.decodedMapBytes / 1048576).toFixed(1)} MiB before mipmaps and copies.`;
    ui('material-list').replaceChildren(...description.objects.map(object => {
      const row = window.document.createElement('li');
      row.textContent = `${object.name} · ${object.uvSets.length} UV sets · ` + object.materials.map(material =>
        `${material.name} (${material.maps.map(map => `${map.semantic} UV${map.uv}`).join(', ') || 'no texture maps'})`).join(' / ');
      return row;
    }));
    const issues = [...inspectCapabilities(adapter, model, document.state, description), ...this.#scan];
    const severity = ['Error', 'Warning', 'Info'];
    issues.sort((a, b) => severity.indexOf(a.severity) - severity.indexOf(b.severity));
    ui('findings').replaceChildren(...issues.map(issue => {
      const row = window.document.createElement('li'), label = window.document.createElement('span');
      row.className = `finding-${issue.severity.toLowerCase()}`;
      label.textContent = `${issue.severity} · ${issue.message}` + (issue.count && issue.count > 1 ? ` (${issue.count})` : '');
      row.append(label);
      if (issue.object) {
        const focus = window.document.createElement('button');
        focus.type = 'button';
        focus.textContent = 'Focus';
        focus.onclick = () => this.#focus(issue);
        row.append(focus);
      }
      return row;
    }));
  }

  #focus(issue: Issue) {
    const adapter = this.#context?.adapter, id = issue.object, node = id && adapter?.objects.get(id);
    if (!adapter || !id || !(node instanceof Mesh)) return;
    this.inspectObject(id);
    if (!issue.sample) { this.viewer.frame(node); return; }
    const topology = adapter.workingTopology(id)!;
    const { kind, index } = issue.sample;
    const ids = kind === 'vertex' ? [index] : kind === 'edge' ? [...topology.edgeVertices.subarray(index * 2, index * 2 + 2)] :
      [...topology.corners.subarray(topology.faceEnds[index - 1] ?? 0, topology.faceEnds[index])];
    const wanted = new Set(ids), render = adapter.mesh.render.get(id)?.render.renderVertices ??
      (adapter.model.format === 'fbx' ? renderControlPoints(sourceMesh(node.geometry)) : undefined);
    const lookup = new Map<number, number>(), indexBuffer = node.geometry.index;
    const count = indexBuffer?.count ?? node.geometry.attributes.position.count;
    for (let i = 0; i < count && lookup.size < wanted.size; i++) {
      const draw = indexBuffer?.getX(i) ?? i, logical = render?.[i] ?? draw;
      if (wanted.has(logical)) lookup.set(logical, draw);
    }
    const points = this.viewer.withPose(() => ids.flatMap(logical => {
      const draw = lookup.get(logical), point = new Vector3();
      if (draw !== undefined) node.getVertexPosition(draw, point);
      else if (logical >= 0 && logical * 3 + 2 < topology.positions.length) {
        point.fromArray(topology.positions, logical * 3);
        if (adapter.model.format === 'fbx') point.applyMatrix4(sourceMesh(node.geometry).preTransform);
      } else return [];
      return [point.applyMatrix4(node.matrixWorld)];
    }));
    this.clearMarker();
    if (!points.length) { this.viewer.frame(node); return; }
    this.#marker.geometry.setAttribute('position', new Float32BufferAttribute(points.flatMap(point => point.toArray()), 3));
    const line = kind === 'vertex' ? [] : kind === 'edge' ? points : points.flatMap((point, i) => [point, points[(i + 1) % points.length]]);
    this.#lines.geometry.setAttribute('position', new Float32BufferAttribute(line.flatMap(point => point.toArray()), 3));
    this.#overlay.visible = true;
    this.viewer.focus(points);
  }
}
