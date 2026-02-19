variable "project_name" {
  description = "Short name used as prefix for all resources (lowercase, no spaces)"
  type        = string
  default     = "bitcaster"
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "eastus"
}

variable "resource_group_name" {
  description = "Name of the Azure resource group"
  type        = string
  default     = "bitcaster-rg"
}

variable "mint_image" {
  description = "Container image for CDK mintd (registry/repo:tag)"
  type        = string
  default     = "ghcr.io/cashubtc/cdk-mintd:latest"
}

variable "common_tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default = {
    project     = "bitCaster"
    environment = "production"
    managed-by  = "terraform"
  }
}
