import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper,
  Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography,
} from '@mui/material';
import { ApiError, errorMessage, request } from '../api';
import type { Role, Status, User, UserChange } from '../types';
import { PageBanner } from '../components/PageBanner';
import { ThemeIcon } from '../components/ThemeIcon';
import { design } from '../theme';

type Listing = { users: User[]; total: number };
const statuses: Status[] = ['PENDING', 'APPROVED', 'REJECTED', 'DISABLED'];
const date = (value: string | null) => value ? new Date(value).toLocaleString() : '—';

export function UserAdmin({ currentUser, refreshAccess }: { currentUser: User; refreshAccess: () => Promise<void> }) {
  const [listing, setListing] = useState<Listing>({ users: [], total: 0 });
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Status | ''>('');
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [selected, setSelected] = useState<User>();
  const [role, setRole] = useState<Role>('USER');
  const [confirmation, setConfirmation] = useState<{ change: UserChange; label: string }>();
  const [saving, setSaving] = useState(false);
  const accessError = useCallback((e: unknown) => {
    setError(errorMessage(e, 'Unable to manage users.'));
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) void refreshAccess();
  }, [refreshAccess]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ page: String(page + 1), text: search, ...(status ? { status } : {}), ...(roleFilter ? { role: roleFilter } : {}) });
      void request<Listing>(`/admin/users?${query}`, { signal: controller.signal })
        .then(data => { if (!controller.signal.aborted) setListing(data); })
        .catch(e => { if (!controller.signal.aborted) accessError(e); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [page, search, status, roleFilter, revision, accessError]);
  const open = (user: User) => { setSelected(user); setRole(user.role); setConfirmation(undefined); setError(''); setSuccess(''); };
  const save = async () => {
    if (!selected || !confirmation) return;
    setSaving(true); setError('');
    try {
      const change = confirmation.change;
      await request<User>(`/admin/users/${selected.id}/${change.action}`, change.action === 'role'
        ? { method: 'PATCH', body: { role: change.role } } : { method: 'POST' });
      setSuccess(`${confirmation.label} completed for ${selected.displayName}.`);
      setSelected(undefined); setConfirmation(undefined); setRevision(v => v + 1);
      await refreshAccess();
    } catch (e) { accessError(e); }
    finally { setSaving(false); }
  };
  return <Stack spacing={3}>
    <PageBanner title="User administration" description="Review account requests, manage application roles and control access" kind="users" actions={<Button variant="outlined" disabled={loading} startIcon={<ThemeIcon kind="refresh" />} onClick={() => { setError(''); setRevision(v => v + 1); }}>Refresh</Button>} />
    {error && <Alert severity="error">{error}</Alert>}
    {success && <Alert severity="success">{success}</Alert>}
    <Paper variant="outlined" sx={{ p: 3, borderLeft: `4px solid ${design.magenta}` }}>
      <Typography variant="subtitle2" color="primary" sx={{ mb: 1 }}>Application users</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>A role assignment does not approve an account. Approve access separately after reviewing the user.</Typography>
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
      <TextField label="Search name or email" value={search} slotProps={{ htmlInput: { maxLength: 200 } }} onChange={e => { setSearch(e.target.value); setPage(0); }} size="small" sx={{ flexGrow: 1 }} />
      <TextField select label="Filter by role" value={roleFilter} onChange={e => { setRoleFilter(e.target.value as Role | ''); setPage(0); }} size="small" sx={{ minWidth: 150 }}>
        <MenuItem value="">All roles</MenuItem><MenuItem value="USER">USER</MenuItem><MenuItem value="ADMIN">ADMIN</MenuItem>
      </TextField>
      <TextField select label="Account status" value={status} onChange={e => { setStatus(e.target.value as Status | ''); setPage(0); }} size="small" sx={{ minWidth: 190 }}>
        <MenuItem value="">All statuses</MenuItem>{statuses.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
      </TextField>
    </Stack>
    </Paper>
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <TableContainer><Table aria-label="Application users">
        <TableHead><TableRow><TableCell>User</TableCell><TableCell>Role</TableCell><TableCell>Status</TableCell><TableCell>Last active</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
        <TableBody>
          {loading ? <TableRow><TableCell colSpan={5}>Loading users…</TableCell></TableRow> : listing.users.length === 0 ?
            <TableRow><TableCell colSpan={5}>No users match these filters.</TableCell></TableRow> : listing.users.map(user => <TableRow key={user.id}>
              <TableCell><Typography variant="body2" fontWeight={600}>{user.displayName}{user.id === currentUser.id ? ' (you)' : ''}</Typography><Typography variant="body2" color="text.secondary">{user.email || 'No email claim supplied'}</Typography></TableCell>
              <TableCell>{user.role}</TableCell><TableCell><Chip size="small" label={user.status} color={user.status === 'APPROVED' ? 'success' : user.status === 'PENDING' ? 'warning' : 'default'} /></TableCell>
              <TableCell>{date(user.lastLoginAt)}</TableCell><TableCell align="right"><Button onClick={() => open(user)} aria-label={`Manage ${user.displayName}`}>Manage</Button></TableCell>
            </TableRow>)}
        </TableBody>
      </Table></TableContainer>
      <TablePagination component="div" count={listing.total} page={page} rowsPerPage={50} rowsPerPageOptions={[50]} onPageChange={(_e, p) => setPage(p)} />
    </Paper>
    <Dialog open={Boolean(selected)} onClose={() => { if (!saving) { setSelected(undefined); setConfirmation(undefined); } }} fullWidth maxWidth="sm">
      <DialogTitle>Manage {selected?.displayName}</DialogTitle>
      <DialogContent><Stack spacing={3} sx={{ pt: 1 }}>
        {error && <Alert severity="error">{error}</Alert>}
        <Box><Typography variant="body2">{selected?.email}</Typography><Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{selected?.subject}</Typography></Box>
        <Typography variant="body2">Status: {selected?.status} · Approved: {date(selected?.approvedAt ?? null)}</Typography>
        {selected?.approvedByUserId && <Typography variant="caption" sx={{ overflowWrap: 'anywhere' }}>Approved by user ID: {selected.approvedByUserId}</Typography>}
        {confirmation ? <Alert severity="warning">Confirm “{confirmation.label}” for this account?{confirmation.change.action === 'role' ? ` The new role will be ${confirmation.change.role}.` : ''}</Alert> : <>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {selected?.status === 'PENDING' && <><Button variant="contained" onClick={() => setConfirmation({ change: { action: 'approve' }, label: 'Approve access' })}>Approve</Button><Button color="error" onClick={() => setConfirmation({ change: { action: 'reject' }, label: 'Reject request' })}>Reject</Button></>}
            {selected?.status === 'APPROVED' && <Button color="error" variant="outlined" onClick={() => setConfirmation({ change: { action: 'disable' }, label: 'Disable account' })}>Disable account</Button>}
            {(selected?.status === 'DISABLED' || selected?.status === 'REJECTED') && <Button variant="outlined" onClick={() => setConfirmation({ change: { action: 'enable' }, label: 'Return to pending approval' })}>Return to pending approval</Button>}
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField select label="Application role" value={role} onChange={e => setRole(e.target.value as Role)} size="small" fullWidth><MenuItem value="USER">USER</MenuItem><MenuItem value="ADMIN">ADMIN</MenuItem></TextField>
            <Button variant="outlined" disabled={role === selected?.role} onClick={() => setConfirmation({ change: { action: 'role', role }, label: 'Change role' })}>Save role</Button>
          </Stack>
        </>}
      </Stack></DialogContent>
      <DialogActions>
        {confirmation ? <><Button disabled={saving} onClick={() => setConfirmation(undefined)}>Back</Button><Button variant="contained" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Confirm'}</Button></> : <Button onClick={() => setSelected(undefined)}>Close</Button>}
      </DialogActions>
    </Dialog>
  </Stack>;
}
