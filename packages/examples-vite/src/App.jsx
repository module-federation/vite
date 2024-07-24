import R from "react"
import RD from "react-dom"
import Mfapp01App from "mfapp01/App"
import Remote2App from "remote2/App"
import Button from "remote3/button"
import { ref } from 'vue'

console.log("share vue", ref)
console.log("share React", R, RD)

export default function () {
  return (
    <div>
      vite react
      <Button />
      <Remote2App />
      <Mfapp01App />
    </div>
  )
}