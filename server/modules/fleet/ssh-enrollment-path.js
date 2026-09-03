export function isSshEnrollmentPath(path) {
  return path.toLowerCase().replace(/\/+$/, '') === '/api/fleet/ssh-enroll';
}
