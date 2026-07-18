<template>
  <div class="flex items-center">
    <svg :width="width" :height="height" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L3 7v6c0 5 3.8 9.7 9 11 5.2-1.3 9-6 9-11V7l-9-5z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
      <path d="M9 12l2 2 4-4" stroke="#0a0a0a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
    <span class="font-bold text-xl ml-2">VOLK AI</span>
  </div>
</template>
<script setup lang="ts">
defineProps({
  width: {
    type: [String, Number],
    default: 28
  },
  height: {
    type: [String, Number],
    default: 28
  }
})
</script>
