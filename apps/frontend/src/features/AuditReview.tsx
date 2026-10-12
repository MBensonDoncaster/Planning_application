import { useEffect, useState } from 'react';
import type { AuditEventListing, AuditEventSummary } from '@planning/contracts';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography } from '@mui/material';
import { ApiError, request } from '../api';
import { PageBanner } from '../components/PageBanner';

const emptyFilters = { dateFrom: '', dateTo: '', actorType: '', actorId: '', module: '', action: '', outcome: '', targetId: '' };
type Filters = typeof emptyFilters;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (value: string, timezone: string) => new Date(value).toLocaleString('en-GB', { timeZone: timezone });
const failureMessage = (error: unknown) => error instanceof ApiError && error.status >= 500 && error.requestId && /^[A-Za-z0-9_-]{1,128}$/.test(error.requestId)
  ? `Unable to load audit events. Request ID: ${error.requestId}` : 'Unable to load audit events. Try again.';

export function AuditReview({ timezone, refreshAccess }: { timezone: string; refreshAccess: () => Promise<void> }) {
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<AuditEventListing>({ events: [], total: 0, page: 1, pageSize: 50 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const [selected, setSelected] = useState<AuditEventSummary>();
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(page + 1) });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    setLoading(true); setError(''); setSelected(undefined);
    void request<AuditEventListing>(`/admin/audit-events?${query}`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setListing(data); })
      .catch(e => {
        if (controller.signal.aborted) return;
        setListing({ events: [], total: 0, page: page + 1, pageSize: 50 });
        setError(failureMessage(e));
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) void refreshAccess();
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, filters, revision, refreshAccess]);
  const apply = () => {
    const next = { ...draft, actorId: draft.actorId.trim(), targetId: draft.targetId.trim(), action: draft.action.trim() };
    if ((next.actorId && !uuid.test(next.actorId)) || (next.targetId && !uuid.test(next.targetId))) { setValidation('Enter a valid UUID for actor and target IDs.'); return; }
    if (next.action && (next.action.length > 100 || !/^[A-Z][A-Z0-9_]*$/.test(next.action))) { setValidation('Enter an action code using uppercase letters, numbers and underscores, starting with a letter.'); return; }
    const from = next.dateFrom ? new Date(next.dateFrom).getTime() : undefined;
    const to = next.dateTo ? new Date(next.dateTo).getTime() : undefined;
    if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to)) || (from !== undefined && to !== undefined && from >= to)) { setValidation('Choose valid dates with the start before the end.'); return; }
    next.dateFrom = from === undefined ? '' : new Date(from).toISOString();
    next.dateTo = to === undefined ? '' : new Date(to).toISOString();
    setValidation(''); setFilters(next); setPage(0);
  };
  const field = (key: keyof Filters, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  return <Stack spacing={3}>
    <PageBanner title="Audit" description="Review retained activity and access decisions" kind="shield" actions={<Button variant="outlined" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh</Button>} />
    <Typography variant="body2">Dates are shown in {timezone}. Each page contains up to 50 events, newest first. Audit events are read-only.</Typography>
    <Stack component="form" spacing={2} onSubmit={e => { e.preventDefault(); apply(); }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField fullWidth label="From (your local time)" type="datetime-local" value={draft.dateFrom} onChange={e => field('dateFrom', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} helperText="Includes events at this time." />
        <TextField fullWidth label="To (your local time)" type="datetime-local" value={draft.dateTo} onChange={e => field('dateTo', e.target.value)} slotProps={{ inputLabel: { shrink: true } }} helperText="Excludes events at this time." />
        <TextField fullWidth select label="Actor type" value={draft.actorType} onChange={e => field('actorType', e.target.value)}><MenuItem value="">All actors</MenuItem>{['USER', 'INTEGRATION', 'SYSTEM', 'UNKNOWN'].map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}</TextField>
      </Stack>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField fullWidth label="Actor ID" value={draft.actorId} onChange={e => field('actorId', e.target.value)} helperText="Retained user, integration or key UUID." />
        <TextField fullWidth select label="Module" value={draft.module} onChange={e => field('module', e.target.value)}><MenuItem value="">All modules</MenuItem><MenuItem value="shared">Shared</MenuItem><MenuItem value="call-for-sites">Call for Sites</MenuItem></TextField>
        <TextField fullWidth label="Action" value={draft.action} onChange={e => field('action', e.target.value)} slotProps={{ htmlInput: { maxLength: 100 } }} helperText="Exact action code, for example USERS_LIST." />
      </Stack>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField fullWidth select label="Outcome" value={draft.outcome} onChange={e => field('outcome', e.target.value)}><MenuItem value="">All outcomes</MenuItem>{['SUCCESS', 'FAILURE', 'DENIED'].map(value => <MenuItem key={value} value={value}>{value}</MenuItem>)}</TextField>
        <TextField fullWidth label="Target ID" value={draft.targetId} onChange={e => field('targetId', e.target.value)} helperText="Retained target UUID." />
      </Stack>
      {validation && <Alert severity="error">{validation}</Alert>}
      <Stack direction="row" spacing={1}><Button type="submit" variant="contained">Apply filters</Button><Button onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); setPage(0); setValidation(''); }}>Reset filters</Button></Stack>
    </Stack>
    {error && <Alert severity="error" action={<Button onClick={() => setRevision(value => value + 1)}>Retry</Button>}>{error}</Alert>}
    {loading ? <Typography role="status">Loading audit events...</Typography> : !error && (listing.events.length === 0 ? <Alert severity="info">No audit events match these filters.</Alert> : <TableContainer><Table aria-label="Audit events"><TableHead><TableRow><TableCell>Occurred at</TableCell><TableCell>Actor</TableCell><TableCell>Module / action</TableCell><TableCell>Outcome</TableCell><TableCell>Target</TableCell><TableCell>Details</TableCell></TableRow></TableHead><TableBody>
      {listing.events.map(event => <TableRow key={event.id}>
        <TableCell>{date(event.occurredAt, timezone)}</TableCell>
        <TableCell>{event.actorType}{event.actorUserId && <Typography variant="caption" display="block">User: {event.actorUserId}</Typography>}{event.actorIntegrationId && <Typography variant="caption" display="block">Integration: {event.actorIntegrationId}</Typography>}{event.actorKeyId && <Typography variant="caption" display="block">Key: {event.actorKeyId}</Typography>}</TableCell>
        <TableCell>{event.module}<Typography>{event.action}</Typography></TableCell><TableCell>{event.outcome}{event.errorCode && <Typography variant="caption" display="block">{event.errorCode}</Typography>}</TableCell>
        <TableCell>{event.targetType ?? 'None'}{event.targetId && <Typography variant="caption" display="block">{event.targetId}</Typography>}</TableCell>
        <TableCell><Button aria-label={`View event ${event.id}`} onClick={() => setSelected(event)}>View details</Button></TableCell>
      </TableRow>)}
    </TableBody></Table></TableContainer>)}
    <TablePagination component="div" count={listing.total} page={page} rowsPerPage={50} rowsPerPageOptions={[50]} onPageChange={(_e, value) => setPage(value)} slotProps={{ actions: { nextButton: { disabled: loading || Boolean(error) || (page + 1) * 50 >= listing.total }, previousButton: { disabled: loading || Boolean(error) || page === 0 } } }} />
    <Dialog open={Boolean(selected)} onClose={() => setSelected(undefined)} fullWidth maxWidth="md"><DialogTitle>Audit event details</DialogTitle><DialogContent>{selected && <Stack spacing={1} sx={{ overflowWrap: 'anywhere' }}>
      <Typography>Event ID: {selected.id}</Typography><Typography>Occurred at: {date(selected.occurredAt, timezone)}</Typography><Typography>Request ID: {selected.requestId}</Typography><Typography>Channel: {selected.channel ?? 'None'}</Typography>
      <Typography>Actor type: {selected.actorType}</Typography><Typography>User ID: {selected.actorUserId ?? 'None'}</Typography><Typography>Integration ID: {selected.actorIntegrationId ?? 'None'}</Typography><Typography>Key ID: {selected.actorKeyId ?? 'None'}</Typography>
      <Typography>Module: {selected.module}</Typography><Typography>Action: {selected.action}</Typography><Typography>Outcome: {selected.outcome}</Typography><Typography>Error code: {selected.errorCode ?? 'None'}</Typography><Typography>Target type: {selected.targetType ?? 'None'}</Typography><Typography>Target ID: {selected.targetId ?? 'None'}</Typography>
      <Typography component="h3">Metadata</Typography><Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{JSON.stringify(selected.metadata, null, 2)}</Typography>
    </Stack>}</DialogContent><DialogActions><Button onClick={() => setSelected(undefined)}>Close</Button></DialogActions></Dialog>
  </Stack>;
}
