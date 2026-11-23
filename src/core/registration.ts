// 配准服务：POS 粗投 -> 同名点 PnP 精化 -> 残差/状态/标记回写
import { PhotoRecord, TiePoint, PhotoFlag } from '../types';
import { EnuFrame } from './geo';
import {
  CameraModel, coarseFromPOS, deserializeCamera, pointResiduals, serializeCamera, solvePnP,
} from './camera';
import { Vec3 } from './math';
import { db } from './db';

export interface RegistrationResult {
  photo: PhotoRecord;
  rms: number;
  residuals: { tie: TiePoint; px: number }[];
  accepted: boolean;
}

// POS 粗位姿(不修改同名点)，返回粗投相机
export function buildCoarseCamera(photo: PhotoRecord, frame: EnuFrame): CameraModel | null {
  if (!photo.pos || !photo.gimbal) return null;
  const center = frame.toLocal(photo.pos);
  const focal = photo.focalMm ?? 8.8;
  return coarseFromPOS(photo.width, photo.height, center, photo.gimbal, focal);
}

// 用同名点精化一张照片；成功后回写记录
export async function registerPhoto(
  photo: PhotoRecord,
  frame: EnuFrame,
  ties: TiePoint[]
): Promise<RegistrationResult> {
  if (ties.length < 4) throw new Error('至少需要 4 个同名点');
  const guessCam = buildCoarseCamera(photo, frame);
  const result = solvePnP({
    width: photo.width,
    height: photo.height,
    observed: ties.map((t) => t.image),
    world: ties.map((t) => [...t.world] as Vec3),
    guess: guessCam
      ? {
          fx: guessCam.fx, fy: guessCam.fy, cx: guessCam.cx, cy: guessCam.cy,
          k1: guessCam.k1, k2: guessCam.k2, pose: { R: guessCam.R, C: guessCam.C },
        }
      : undefined,
  });
  const residualPx = pointResiduals(result.camera, ties);
  const paired = ties.map((tie, i) => ({ tie: { ...tie, residual: residualPx[i] }, px: residualPx[i] }));
  const rms = result.rms;
  const flags = new Set<PhotoFlag>(photo.flags);
  const accepted = rms <= 1.5;
  if (!accepted) flags.add('high_residual');
  else flags.delete('high_residual');

  const updated: PhotoRecord = {
    ...photo,
    tiePoints: paired.map((p) => p.tie),
    camera: serializeCamera(result.camera),
    rms,
    status: accepted ? 'registered' : 'coarse',
    flags: [...flags],
  };
  await db.savePhoto(updated);
  return { photo: updated, rms, residuals: paired, accepted };
}

// 批量 POS 粗投(无同名点的照片先标 coarse)
export async function applyCoarseBatch(photos: PhotoRecord[], frame: EnuFrame): Promise<PhotoRecord[]> {
  const out: PhotoRecord[] = [];
  for (const p of photos) {
    if (p.status === 'registered') {
      out.push(p);
      continue;
    }
    const cam = buildCoarseCamera(p, frame);
    if (!cam) {
      const flags = new Set(p.flags);
      flags.add('no_pos');
      const next = { ...p, status: 'pending' as const, flags: [...flags], camera: null, rms: null };
      await db.savePhoto(next);
      out.push(next);
      continue;
    }
    const next: PhotoRecord = {
      ...p,
      camera: serializeCamera(cam),
      status: 'coarse',
      rms: null,
    };
    await db.savePhoto(next);
    out.push(next);
  }
  return out;
}

export function cameraOf(photo: PhotoRecord): CameraModel | null {
  return photo.camera ? deserializeCamera(photo.camera) : null;
}
