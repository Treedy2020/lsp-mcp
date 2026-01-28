<template>
  <div class="app">
    <h1>{{ title }}</h1>
    <p>Count: {{ count }}</p>
    <button @click="increment">Increment</button>
    <HelloWorld :msg="greeting" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import HelloWorld from './components/HelloWorld.vue'

const title = ref<string>('Vue Test App')
const count = ref<number>(0)

const greeting = computed(() => `Hello from Vue! Count is ${count.value}`)

function increment(): void {
  count.value++
}
</script>

<style scoped>
.app {
  padding: 20px;
}
</style>
