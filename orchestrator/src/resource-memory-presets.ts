import os from 'node:os';

export const MEMORY_PRESETS = [
  { ramGb: 8, missionGb: 2, dayGb: 3, nightGb: 4 },
  { ramGb: 16, missionGb: 4, dayGb: 6, nightGb: 8 },
  { ramGb: 32, missionGb: 8, dayGb: 10, nightGb: 16 },
  { ramGb: 64, missionGb: 12, dayGb: 16, nightGb: 24 },
] as const;

export type MemoryClass = typeof MEMORY_PRESETS[number]['ramGb'];

export function resourceMemoryInfo(totalBytes = os.totalmem()) {
  const detectedRamGb = totalBytes / 1024 ** 3;
  // totalmem() excludes RAM reserved by the kernel and firmware. Allow 10%
  // below nominal capacity so ordinary machines keep their intended class.
  const autoClassGb = [...MEMORY_PRESETS].reverse()
    .find((preset) => detectedRamGb >= preset.ramGb * 0.9)?.ramGb ?? 8;
  return { detectedRamGb, autoClassGb, presets: MEMORY_PRESETS };
}

export function memoryPresetSettings(ramGb: MemoryClass): Record<string, number> {
  const preset = MEMORY_PRESETS.find((entry) => entry.ramGb === ramGb)!;
  return {
    ROOKS_MISSION_MEM_MAX_GB: preset.missionGb,
    ROOKS_DAY_MEM_MAX_GB: preset.dayGb,
    ROOKS_NIGHT_MEM_MAX_GB: preset.nightGb,
  };
}
