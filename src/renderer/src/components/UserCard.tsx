import { useStore } from '../store'

export function UserCard() {
  const user = useStore((s) => s.user)
  const status = useStore((s) => s.status)

  return (
    <>
      <div className="section-title">User</div>
      <div className="usercard">
        {!user ? (
          <div className="muted">{status === 'connecting' ? 'Connecting…' : 'Not logged in'}</div>
        ) : (
          <>
            <div className="name">{user.name}</div>
            <dl>
              <dt>Email</dt>
              <dd title={user.email}>{user.email}</dd>
              <dt>Username</dt>
              <dd title={user.username}>{user.username}</dd>
              <dt>User Id</dt>
              <dd>{user.id}</dd>
              <dt>Profile</dt>
              <dd>{user.profileName ?? '—'}</dd>
              <dt>Role</dt>
              <dd>{user.roleName ?? '—'}</dd>
              <dt>Time zone</dt>
              <dd>{user.timeZone}</dd>
              <dt>Org Id</dt>
              <dd>{user.orgId}</dd>
              <dt>Instance</dt>
              <dd title={user.instanceUrl}>{user.instanceUrl.replace(/^https:\/\//, '')}</dd>
            </dl>
          </>
        )}
      </div>
    </>
  )
}
