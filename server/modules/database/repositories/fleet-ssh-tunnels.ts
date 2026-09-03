import Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';

export type FleetSshTunnelRecord = Readonly<{
  peerId: string;
  sshTarget: string;
  sshPort?: number;
  localPort: number;
  controlPath?: string;
}>;

type TunnelRow = Readonly<{ peer_id: unknown; ssh_target: unknown; ssh_port: unknown; local_port: unknown; control_path: unknown }>;

export class FleetSshTunnelDataError extends Error {
  readonly name = 'FleetSshTunnelDataError';
  constructor(readonly field: string) { super(`Malformed persisted fleet SSH tunnel field: ${field}`); }
}

function parsePort(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) throw new FleetSshTunnelDataError(field);
  return value;
}
function parseRow(row: TunnelRow): FleetSshTunnelRecord {
  if (typeof row.peer_id !== 'string' || row.peer_id.length === 0) throw new FleetSshTunnelDataError('peer_id');
  if (typeof row.ssh_target !== 'string' || row.ssh_target.length === 0) throw new FleetSshTunnelDataError('ssh_target');
  if (row.ssh_port !== null) parsePort(row.ssh_port, 'ssh_port');
  if (typeof row.control_path !== 'string') throw new FleetSshTunnelDataError('control_path');
  return { peerId: row.peer_id, sshTarget: row.ssh_target, localPort: parsePort(row.local_port, 'local_port'), ...(row.ssh_port === null ? {} : { sshPort: parsePort(row.ssh_port, 'ssh_port') }), ...(row.control_path.length === 0 ? {} : { controlPath: row.control_path }) };
}

export class FleetSshTunnelsRepository {
  constructor(private readonly injectedDb?: Database.Database) {}
  private get db(): Database.Database { return this.injectedDb ?? getConnection(); }
  findByPeerId(peerId: string): FleetSshTunnelRecord | undefined {
    const row = this.db.prepare<[string], TunnelRow>('SELECT peer_id, ssh_target, ssh_port, local_port, control_path FROM fleet_ssh_tunnels WHERE peer_id = ?').get(peerId);
    return row === undefined ? undefined : parseRow(row);
  }
  findByTarget(sshTarget: string): FleetSshTunnelRecord | undefined {
    const row = this.db.prepare<[string], TunnelRow>('SELECT peer_id, ssh_target, ssh_port, local_port, control_path FROM fleet_ssh_tunnels WHERE ssh_target = ?').get(sshTarget);
    return row === undefined ? undefined : parseRow(row);
  }
  list(): readonly FleetSshTunnelRecord[] {
    return this.db.prepare<[], TunnelRow>('SELECT peer_id, ssh_target, ssh_port, local_port, control_path FROM fleet_ssh_tunnels ORDER BY peer_id').all().map(parseRow);
  }
  save(record: FleetSshTunnelRecord): void {
    if (record.controlPath === undefined || record.controlPath.length === 0) throw new FleetSshTunnelDataError('control_path');
    this.db.prepare(`INSERT INTO fleet_ssh_tunnels (peer_id, ssh_target, ssh_port, local_port, control_path)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET ssh_target = excluded.ssh_target,
      ssh_port = excluded.ssh_port, local_port = excluded.local_port, control_path = excluded.control_path`).run(record.peerId, record.sshTarget, record.sshPort ?? null, record.localPort, record.controlPath);
  }
  delete(peerId: string): void { this.db.prepare('DELETE FROM fleet_ssh_tunnels WHERE peer_id = ?').run(peerId); }
}

export const fleetSshTunnelsDb = new FleetSshTunnelsRepository();
