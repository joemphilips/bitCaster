# ---------------------------------------------------------------------------
# Azure Static Web Apps — bitCaster PWA hosting + CDN
# ---------------------------------------------------------------------------

variable "resource_group_name" { type = string }
variable "location"            { type = string }
variable "project_name"        { type = string }
variable "common_tags"         { type = map(string) }

resource "azurerm_static_web_app" "frontend" {
  name                = "${var.project_name}-swa"
  resource_group_name = var.resource_group_name
  # Static Web Apps are a global service; location sets the data region.
  location            = var.location
  sku_tier            = "Free"
  sku_size            = "Free"
  tags                = var.common_tags
}

output "default_hostname" {
  description = "Default CDN hostname for the Static Web App"
  value       = azurerm_static_web_app.frontend.default_host_name
}

output "api_key" {
  description = "Deployment API key (used by CI/CD to publish the PWA)"
  value       = azurerm_static_web_app.frontend.api_key
  sensitive   = true
}
