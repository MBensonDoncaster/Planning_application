import { useEffect, useState } from 'react';
import type { ApiKeySummary, IntegrationListing, IntegrationWithKeys, KeyCreatedResponse, KeyRotatedResponse, PublicLimits } from '@planning/contracts';
import { Alert, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from '@mui/material';
import { ApiError, request } from '../api';
import { PageBanner } from '../components/PageBanner';

type Action = { kind: 'create' } | { kind: 'key'; integration: IntegrationWithKeys } | { kind: 'toggle'; integration: IntegrationWithKeys } | { kind: 'rotate'; key: ApiKeySummary } | { kind: 'revoke'; key: ApiKeySummary };
const date = (value: string | null, timezone: string) => value ? new Date(value).toLocaleString('en-GB', { timeZone: timezone }) : 'Never';
const failureMessage = (error: unknown, message: string) => error instanceof ApiError && error.status >= 500 && error.requestId && /^[A-Za-z0-9_-]{1,128}$/.test(error.requestId)
  ? `${message} Request ID: ${error.requestId}` : message;
const localDate = (value: Date) => {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

export function IntegrationAdmin({ limits, timezone, refreshAccess }: { limits: Pick<PublicLimits, 'apiKeyDefaultExpiryDays' | 'apiKeyMaxExpiryDays'>; timezone: string; refreshAccess: () => Promise<void> }) {
  const [listing, setListing] = useState<IntegrationListing>({ integrations: [], total: 0, page: 1, pageSize: 50 });
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [action, setAction] = useState<Action>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState(true);
  const [expiry, setExpiry] = useState('');
  const [overlap, setOverlap] = useState('0');
  const [saving, setSaving] = useState(false);
  const [oneTime, setOneTime] = useState<KeyCreatedResponse & { previousKeyRevokesAt?: string }>();
  const [copyNotice, setCopyNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void request<IntegrationListing>(`/admin/integrations?page=${page + 1}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setListing(data); })
      .catch(e => {
        if (controller.signal.aborted) return;
        setError(failureMessage(e, 'Unable to load integrations. Refresh to try again.'));
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) void refreshAccess();
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, revision, refreshAccess]);
  const open = (next: Action) => {
    setAction(next); setOneTime(undefined); setCopyNotice(''); setError(''); setSuccess('');
    setName(''); setDescription(''); setScope(true); setOverlap('0');
    setExpiry(localDate(new Date(Date.now() + limits.apiKeyDefaultExpiryDays * 86_400_000)));
  };
  const close = () => { if (!saving) { setAction(undefined); setOneTime(undefined); setCopyNotice(''); setError(''); } };
  const submit = async () => {
    if (!action || saving) return;
    setError('');
    if ((action.kind === 'create' || action.kind === 'key') && (!name.trim() || Array.from(name.trim()).length > 200)) {
      setError('Enter a name or label of 1–200 characters.'); return;
    }
    let expiresAt: string | undefined;
    if (action.kind === 'key' || action.kind === 'rotate') {
      const timestamp = new Date(expiry).getTime();
      if (!Number.isFinite(timestamp) || timestamp <= Date.now() || timestamp > Date.now() + limits.apiKeyMaxExpiryDays * 86_400_000) {
        setError(`Select a future expiry within ${limits.apiKeyMaxExpiryDays} days.`); return;
      }
      expiresAt = new Date(timestamp).toISOString();
      if (action.kind === 'key' && !scope) { setError('Select Call for Sites Submit.'); return; }
      if (action.kind === 'rotate' && (!overlap.trim() || !Number.isFinite(Number(overlap)) || Number(overlap) < 0 || Number(overlap) > 24)) {
        setError('Overlap must be between 0 and 24 hours.'); return;
      }
    }
    setSaving(true);
    try {
      if (action.kind === 'create') {
        await request('/admin/integrations', { method: 'POST', body: { name: name.trim(), description: description.trim() } });
      } else if (action.kind === 'toggle') {
        await request(`/admin/integrations/${action.integration.id}`, { method: 'PATCH', body: { enabled: !action.integration.enabled } });
      } else if (action.kind === 'revoke') {
        await request(`/admin/api-keys/${action.key.id}/revoke`, { method: 'POST' });
      } else {
        const result = action.kind === 'key'
          ? await request<KeyCreatedResponse>(`/admin/integrations/${action.integration.id}/keys`, { method: 'POST', body: { label: name.trim(), capabilities: ['call-for-sites.submit'], expiresAt } })
          : await request<KeyRotatedResponse>(`/admin/api-keys/${action.key.id}/rotate`, { method: 'POST', body: { expiresAt, overlapHours: Number(overlap) } });
        setOneTime(result);
      }
      if (action.kind !== 'key' && action.kind !== 'rotate') { setAction(undefined); setSuccess('Integration administration change completed.'); }
      setRevision(value => value + 1);
    } catch (e) {
      // Error bodies can originate outside the application; never echo them beside a secret.
      setError(failureMessage(e, e instanceof ApiError && e.status === 409 ? 'This change conflicts with the current integration or key. Refresh and try again.' : 'Unable to complete this change. Check your inputs and try again.'));
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setOneTime(undefined); void refreshAccess(); }
    } finally { setSaving(false); }
  };
  const copy = async () => {
    if (!oneTime) return;
    try { await navigator.clipboard.writeText(oneTime.secret); setCopyNotice('Copied. Save the key in your secure credential store.'); }
    catch { setCopyNotice('Copy unavailable. Select and copy the key manually.'); }
  };
  const title = oneTime ? 'Save your API key' : action?.kind === 'create' ? 'Create integration' : action?.kind === 'key' ? 'Generate API key' : action?.kind === 'rotate' ? 'Rotate API key' : action?.kind === 'revoke' ? 'Revoke API key' : action?.kind === 'toggle' ? `${action.integration.enabled ? 'Disable' : 'Re-enable'} integration` : '';
  return <Stack spacing={3}>
    <PageBanner title="Integrations" description="Manage submission access for automated uploads" kind="shield" actions={<Button variant="outlined" disabled={loading || saving || Boolean(action)} onClick={() => { setError(''); setRevision(v => v + 1); }}>Refresh</Button>} />
    {error && !action && <Alert severity="error">{error}</Alert>}
    {success && <Alert severity="success">{success}</Alert>}
    <Stack direction="row" justifyContent="space-between" alignItems="center"><Typography variant="body2">Dates are shown in {timezone}. Lists contain no secret keys.</Typography><Button variant="contained" disabled={saving || Boolean(action)} onClick={() => open({ kind: 'create' })}>Create integration</Button></Stack>
    {loading ? <Typography role="status">Loading integrations…</Typography> : listing.integrations.length === 0 ? <Alert severity="info">No integrations on this page.</Alert> : listing.integrations.map(integration => <Paper key={integration.id} variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="start">
          <Stack sx={{ flexGrow: 1 }}><Typography variant="h6" component="h2">{integration.name}</Typography>{integration.description && <Typography variant="body2">{integration.description}</Typography>}<Typography variant="caption">Integration ID: {integration.id}</Typography></Stack>
          <Chip label={integration.enabled ? 'Enabled' : 'Disabled'} color={integration.enabled ? 'success' : 'default'} />
          <Button aria-label={`${integration.enabled ? 'Disable' : 'Re-enable'} ${integration.name}`} onClick={() => open({ kind: 'toggle', integration })}>{integration.enabled ? 'Disable' : 'Re-enable'}</Button>
          <Button disabled={!integration.enabled} aria-label={`Generate key for ${integration.name}`} onClick={() => open({ kind: 'key', integration })}>Generate key</Button>
        </Stack>
        <TableContainer><Table aria-label={`API keys for ${integration.name}`}><TableHead><TableRow><TableCell>Key / public prefix</TableCell><TableCell>Effective functionality</TableCell><TableCell>Status</TableCell><TableCell>Effective expiry</TableCell><TableCell>Last authenticated use</TableCell><TableCell>Actions</TableCell></TableRow></TableHead><TableBody>
          {integration.keys.length === 0 ? <TableRow><TableCell colSpan={6}>No keys created.</TableCell></TableRow> : integration.keys.map(key => <TableRow key={key.id}>
            <TableCell>{key.label}<Typography variant="caption" display="block">{key.publicPrefix}</Typography></TableCell>
            <TableCell>{key.effectiveCapabilities.includes('call-for-sites.submit') ? 'Call for Sites Submit' : 'None'}</TableCell>
            <TableCell>{key.status.replaceAll('_', ' ')}</TableCell>
            <TableCell>{date(key.effectiveExpiresAt, timezone)}<Typography variant="caption" display="block">Original expiry: {date(key.expiresAt, timezone)}</Typography></TableCell>
            <TableCell>{date(key.lastUsedAt, timezone)}</TableCell>
            <TableCell><Button disabled={!integration.enabled || key.status !== 'ACTIVE'} aria-label={`Rotate ${key.label}`} onClick={() => open({ kind: 'rotate', key })}>Rotate</Button><Button color="error" disabled={key.status === 'REVOKED'} aria-label={`Revoke ${key.label}`} onClick={() => open({ kind: 'revoke', key })}>Revoke</Button></TableCell>
          </TableRow>)}
        </TableBody></Table></TableContainer>
      </Stack>
    </Paper>)}
    <TablePagination component="div" slotProps={{ actions: { nextButton: { disabled: Boolean(action) || loading || (page + 1) * 50 >= listing.total }, previousButton: { disabled: Boolean(action) || loading || page === 0 } } }} count={listing.total} page={page} rowsPerPage={50} rowsPerPageOptions={[50]} onPageChange={(_e, value) => { setOneTime(undefined); setPage(value); }} />
    <Dialog open={Boolean(action)} onClose={close} fullWidth maxWidth="sm"><DialogTitle>{title}</DialogTitle><DialogContent><Stack spacing={2} sx={{ pt: 1 }}>
      {error && <Alert severity="error">{error}</Alert>}
      {oneTime ? <>
        <Alert severity="warning">This key is shown once. Copy it now into your secure credential store. After closing, a lost secret requires a new key.</Alert>
        <TextField label="One-time API key" value={oneTime.secret} multiline slotProps={{ input: { readOnly: true } }} />
        <Button onClick={() => void copy()}>Copy key</Button>{copyNotice && <Typography role="status">{copyNotice}</Typography>}
        <Typography>New key effective expiry: {date(oneTime.key.effectiveExpiresAt, timezone)}</Typography>
        {oneTime.previousKeyRevokesAt && <Typography>Previous key effective expiry: {date(oneTime.previousKeyRevokesAt, timezone)}</Typography>}
      </> : <>
        {(action?.kind === 'create' || action?.kind === 'key') && <TextField label={action.kind === 'create' ? 'Integration name' : 'Key label'} value={name} disabled={saving} onChange={e => setName(e.target.value)} slotProps={{ htmlInput: { maxLength: 200 } }} />}
        {action?.kind === 'create' && <TextField label="Description (optional)" multiline value={description} disabled={saving} onChange={e => setDescription(e.target.value)} slotProps={{ htmlInput: { maxLength: 2000 } }} />}
        {action?.kind === 'key' && <FormControlLabel control={<Checkbox checked={scope} disabled={saving} onChange={e => setScope(e.target.checked)} />} label="Call for Sites Submit" />}
        {(action?.kind === 'key' || action?.kind === 'rotate') && <TextField label="New key expiry (your local time)" type="datetime-local" value={expiry} disabled={saving} onChange={e => setExpiry(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} helperText={`Must be in the future and within ${limits.apiKeyMaxExpiryDays} days.`} />}
        {action?.kind === 'rotate' && <><Typography>The replacement keeps the existing functionality. By default, the previous key is revoked immediately.</Typography><TextField label="Overlap hours" type="number" value={overlap} disabled={saving} onChange={e => setOverlap(e.target.value)} slotProps={{ htmlInput: { min: 0, max: 24, step: 0.5 } }} helperText="Choose 0 for immediate revocation, or an explicit overlap of up to 24 hours." /></>}
        {action?.kind === 'toggle' && <Alert severity="warning">{action.integration.enabled ? `Disable ${action.integration.name}? All its keys will stop working on their next request.` : `Re-enable ${action.integration.name}? Expired and revoked keys will remain unusable.`}</Alert>}
        {action?.kind === 'revoke' && <Alert severity="warning">Revoke {action.key.label} immediately? This cannot be undone, including during a rotation overlap.</Alert>}
      </>}
    </Stack></DialogContent><DialogActions>{oneTime ? <Button onClick={close}>Close and clear key</Button> : <><Button disabled={saving} onClick={close}>Cancel</Button><Button variant="contained" disabled={saving} onClick={() => void submit()}>{saving ? 'Saving…' : action?.kind === 'create' ? 'Create integration' : action?.kind === 'key' ? 'Generate key' : action?.kind === 'rotate' ? 'Confirm rotation' : 'Confirm'}</Button></>}</DialogActions></Dialog>
  </Stack>;
}
