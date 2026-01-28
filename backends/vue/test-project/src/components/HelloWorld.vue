<template>
  <div class="hello">
    <p>{{ msg }}</p>
    <UserInfo :user="currentUser" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import UserInfo from './UserInfo.vue'

interface User {
  name: string
  age: number
  email: string
}

defineProps<{
  msg: string
}>()

const currentUser = ref<User>({
  name: 'John Doe',
  age: 30,
  email: 'john@example.com'
})
</script>
