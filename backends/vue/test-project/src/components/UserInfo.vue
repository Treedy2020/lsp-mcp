<template>
  <div class="user-info">
    <h3>User Information</h3>
    <ul>
      <li>Name: {{ user.name }}</li>
      <li>Age: {{ user.age }}</li>
      <li>Email: {{ user.email }}</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
interface User {
  name: string
  age: number
  email: string
}

defineProps<{
  user: User
}>()
</script>
