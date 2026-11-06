import { TIMON_HOME } from '../../paths.js';
import { AcpRegistryService } from './service.js';

let shared: AcpRegistryService | null = null;

/** One service per daemon: the boot restores through it, the routes mutate it. */
export function acpRegistryService(): AcpRegistryService {
  shared ??= new AcpRegistryService({ home: TIMON_HOME });
  return shared;
}

/** Test seam. */
export function setAcpRegistryService(service: AcpRegistryService | null): void {
  shared = service;
}
