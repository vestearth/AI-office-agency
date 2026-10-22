import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  HalfFloatType,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  SpotLight,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import { ZONES } from '../commandZones';
import { SPOT_INTENSITY, type GlowItem, type RoomGlow } from './officeNight';

const dummy = new Object3D();

export function radialTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgb(255,255,255)');
    gradient.addColorStop(0.35, 'rgb(200,200,200)');
    gradient.addColorStop(0.7, 'rgb(70,70,70)');
    gradient.addColorStop(1, 'rgb(0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

export function poolMaterial(map: CanvasTexture): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color: '#ffffff',
    alphaMap: map,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
}

export function flatPlane(): BufferGeometry {
  return new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
}

export function GlowInstances({ geometry, material, items }: {
  geometry: BufferGeometry;
  material: MeshBasicMaterial;
  items: GlowItem[];
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((item, index) => {
      dummy.position.set(item.x, item.y, item.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(item.sx, item.sy, item.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      mesh.setColorAt(index, item.color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [items]);
  if (items.length === 0) return null;
  return (
    <instancedMesh
      key={items.length}
      ref={ref}
      args={[geometry, material, items.length]}
      frustumCulled={false}
      raycast={() => null}
    />
  );
}

/** One SpotLight per room, always in the scene. A dark room is intensity 0, not removed. */
export function RoomSpots({ glows, animate }: { glows: RoomGlow[]; animate: boolean }) {
  const { scene, invalidate } = useThree();
  const lights = useMemo(() => ZONES.map(() => {
    const light = new SpotLight('#ffffff', 0, 16, 0.5, 0.8, 2);
    light.castShadow = false;
    return light;
  }), []);
  useEffect(() => {
    for (const light of lights) scene.add(light, light.target);
    return () => {
      for (const light of lights) {
        scene.remove(light, light.target);
        light.dispose();
      }
    };
  }, [lights, scene]);
  useEffect(() => {
    glows.forEach((room, index) => {
      const light = lights[index];
      if (!light) return;
      light.position.set(room.x, 6.5, room.z + 0.4);
      light.target.position.set(room.x, 0, room.z + 0.2);
      light.target.updateMatrixWorld();
      light.color.set(room.tone);
      light.userData.base = room.level * SPOT_INTENSITY * (room.hot ? 1.6 : 1);
      light.userData.eye = room.eye;
      light.intensity = light.userData.base;
    });
    invalidate();
  }, [glows, lights, invalidate]);
  useFrame((state) => {
    if (!animate) return;
    const wave = 0.75 + 0.35 * Math.sin(state.clock.elapsedTime * 3.1);
    for (const light of lights) if (light.userData.eye) light.intensity = light.userData.base * wave;
  });
  return null;
}

export function NightPulse({ materials, animate }: { materials: MeshBasicMaterial[]; animate: boolean }) {
  useFrame((state) => {
    const wave = animate ? 0.7 + 0.4 * Math.sin(state.clock.elapsedTime * 3.1) : 1;
    for (const material of materials) material.color.setScalar(wave);
  });
  return null;
}

/**
 * Bloom chain from three/examples. Resets the info counters once per frame so
 * `dataset.draws` is the whole chain, not only the last pass.
 */
export function NightPost() {
  const { gl, scene, camera, size } = useThree();
  const passes = useMemo(() => {
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    const composer = new EffectComposer(gl, target);
    const render = new RenderPass(scene, camera);
    const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.85, 0.55, 0.9);
    composer.addPass(render);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    return { composer, render };
  }, [gl, scene, camera]);
  useEffect(() => {
    passes.composer.setPixelRatio(gl.getPixelRatio());
    passes.composer.setSize(size.width, size.height);
  }, [passes, gl, size]);
  useEffect(() => () => passes.composer.dispose(), [passes]);
  useFrame(() => {
    gl.info.autoReset = false;
    gl.info.reset();
    const original = passes.render.render.bind(passes.render);
    let sceneCalls = 0;
    passes.render.render = (...args: Parameters<RenderPass['render']>) => {
      original(...args);
      sceneCalls = gl.info.render.calls;
    };
    passes.composer.render();
    passes.render.render = original;
    const stage = gl.domElement;
    stage.dataset.draws = String(gl.info.render.calls);
    stage.dataset.sceneDraws = String(sceneCalls);
    stage.dataset.frames = String((Number(stage.dataset.frames) || 0) + 1);
  }, 1);
  return null;
}
