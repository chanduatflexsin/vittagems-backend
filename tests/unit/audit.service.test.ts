import { AuditService } from '../../src/modules/audit/audit.service';
import { prismaMock } from '../setup';

describe('AuditService.log', () => {
  it('writes an audit log entry with clientId, action and details', async () => {
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    await AuditService.log('client-1', 'API_ACCESS', { path: '/x' });

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: { clientId: 'client-1', action: 'API_ACCESS', details: { path: '/x' } },
    });
  });

  it('defaults details to {} when omitted', async () => {
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    await AuditService.log('client-1', 'SOME_EVENT');

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: { clientId: 'client-1', action: 'SOME_EVENT', details: {} },
    });
  });

  it('allows a null clientId (system-level events)', async () => {
    prismaMock.auditLog.create.mockResolvedValue({} as any);

    await AuditService.log(null, 'SYSTEM_EVENT');

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: { clientId: null, action: 'SYSTEM_EVENT', details: {} },
    });
  });

  it('swallows DB errors so a failed audit log never throws or blocks the caller', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    prismaMock.auditLog.create.mockRejectedValue(new Error('DB down'));

    await expect(AuditService.log('client-1', 'API_ACCESS')).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
