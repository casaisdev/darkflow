# Local fonts

**Departure Mono** (`DepartureMono-Regular.woff2`) belongs here. It is the mono
face chosen for DARKFLOW. It is not on Google Fonts, so the file has to be
fetched by hand from <https://departuremono.com/> under its own license.

Until it lands, the app uses IBM Plex Mono via `next/font/google`.

To switch: uncomment the `departureMono` block in `app/fonts.ts` and point
`export const mono` at it. That is the only line that changes.
