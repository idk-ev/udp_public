<!--
  SPDX-License-Identifier: EUPL-1.2
  © 2024–2026 Thomas Kieß and contributors
-->
<script lang="ts">
  // This file must NOT lint clean (tests/static/admin-type-discipline.test.js).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const loose: any = 1;
  const asserted = (loose as string).length;
  const maybe: string | undefined = undefined;
  const forced = maybe!.length;
</script>

<p>{asserted} {forced}</p>
