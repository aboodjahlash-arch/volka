<template>
  <span class="font-bold text-sm ml-1">VOLK AI</span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: number;
}>(), {
  size: 20,
});
</script>
