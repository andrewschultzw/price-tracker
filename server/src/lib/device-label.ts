// Derive a human-readable device+browser label from User-Agent string
export function deriveDeviceLabel(userAgent: string): string {
  // Browser detection: order matters (check Edge before Chrome, since Edge UA contains both)
  const browser =
    /Edg\//.test(userAgent) ? 'Edge' :
    /Firefox\//.test(userAgent) ? 'Firefox' :
    /Chrome\//.test(userAgent) ? 'Chrome' :
    /Safari\//.test(userAgent) ? 'Safari' :
    'Browser';

  // Platform detection: order matters (check iPhone/iPad/Android before Macintosh,
  // since iPhone UA contains "Mac OS X")
  const platform =
    /iPhone/.test(userAgent) ? 'iPhone' :
    /iPad/.test(userAgent) ? 'iPad' :
    /Android/.test(userAgent) ? 'Android' :
    /Macintosh/.test(userAgent) ? 'Mac' :
    /Windows/.test(userAgent) ? 'Windows' :
    /Linux/.test(userAgent) ? 'Linux' :
    'Device';

  return `${platform} · ${browser}`;
}
