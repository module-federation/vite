<script context="module">
  import 'remoteA/module-setup';
</script>

<script lang="ts">
  import { helper } from 'remoteA/shared/helpers';
  export let label: string = helper;
</script>

<!-- import { fake } from 'remoteB/html-comment' -->
<p>{label} import 'remoteB/template-only'</p>

<style>
  /* import 'remoteB/style-comment' */
  p::before {
    content: "import 'remoteB/css-string'";
  }
</style>
